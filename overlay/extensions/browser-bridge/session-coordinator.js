/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./provider-utils.js') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriSessionCoordinator = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';
  const MAX_TABS = 20;
  const MAX_RECORDS = 200;
  const clone = value => JSON.parse(JSON.stringify(value));
  const defaultUuid = () => crypto.randomUUID();
  function newState(browserRunId) { return { v: 1, browserRunId, tabs: {}, sessions: {} }; }
  function validState(state) {
    if (!state || state.v !== 1 || !utils.ID.test(state.browserRunId || '')
      || !state.tabs || !state.sessions || Array.isArray(state.sessions)
      || Object.keys(state.sessions).length > MAX_RECORDS) return false;
    for (const [id, session] of Object.entries(state.sessions)) {
      if (!session || id !== session.sessionId || !utils.ID.test(id)
        || !Number.isSafeInteger(session.tabId) || session.tabId < 0
        || !utils.ID.test(session.pageInstanceId || '') || !utils.ID.test(session.documentId || '')
        || !['chatgpt', 'claude'].includes(session.provider)
        || !Number.isSafeInteger(session.sequence) || session.sequence < 0
        || !Number.isSafeInteger(session.generation) || session.generation < 0
        || !Number.isSafeInteger(session.routeRevision) || session.routeRevision < 0
        || !['idle', 'running', 'settled'].includes(session.phase)
        || ![null, 'interrupted', 'error', 'unverified'].includes(session.outcome)
        || !['fresh', 'stale', 'closed', 'unsupported'].includes(session.observation)) return false;
      for (const field of ['conversationTitle', 'requestPreview']) {
        if (Object.hasOwn(session, field) && !utils.validMetadataText(session[field])) return false;
      }
    }
    for (const [tabId, id] of Object.entries(state.tabs)) {
      if (!state.sessions[id] || String(state.sessions[id].tabId) !== tabId || state.sessions[id].closed) return false;
    }
    return true;
  }

  function makeEvent(state, record, kind, uuid, observedAt, replay = false) {
    record.sequence++;
    const event = {
      type: 'event', v: 1,
      eventId: kind === 'terminal' ? `terminal-${record.turnId}`
        : kind === 'closed' ? `closed-${record.sessionId}-${record.routeRevision}` : uuid(),
      browserRunId: state.browserRunId, sessionId: record.sessionId,
      sequence: record.sequence, kind, provider: record.provider,
      tabId: record.tabId, pageInstanceId: record.pageInstanceId,
      routeRevision: record.routeRevision, conversationRef: record.conversationRef,
      turnId: record.turnId, generation: record.generation,
      phase: record.phase, outcome: record.outcome,
      observation: record.observation, observedAt, replay,
      conversationTitle: record.conversationTitle ?? '', requestPreview: record.requestPreview ?? '',
    };
    record.latestEvent = event;
    return event;
  }

  function closeRecord(state, record, events, uuid, now) {
    if (!record || record.closed) return;
    record.closed = true; record.observation = 'closed';
    delete state.tabs[record.tabId];
    if (record.announced) events.push(makeEvent(state, record, 'closed', uuid, now));
    else delete state.sessions[record.sessionId];
  }

  function reduceObservation(original, input, context, { uuid = defaultUuid, now = Date.now() } = {}) {
    const observation = utils.safeObservation(input);
    const route = context.route;
    if (!observation || !route || !utils.ID.test(context.documentId || '')
      || !Number.isSafeInteger(context.tabId) || context.tabId < 0) {
      return { state: original, events: [], diagnostic: 'invalid_observation' };
    }
    if (Math.abs(now - observation.observedAt) > 30000) {
      return { state: original, events: [], diagnostic: 'old_observation' };
    }
    const state = clone(original);
    const events = [];
    let record = state.sessions[state.tabs[context.tabId]];
    if (record) {
      const changedConversation = record.provider !== route.provider
        || record.conversationRef !== route.conversationRef;
      const assignment = record.provider === route.provider && record.conversationRef === null
        && route.conversationRef !== null && record.phase === 'running'
        && record.documentId === context.documentId && record.pageInstanceId === observation.pageInstanceId;
      const changedEmptyScope = record.conversationRef === null && route.conversationRef === null
        && record.documentId === context.documentId && record.pageInstanceId !== observation.pageInstanceId;
      if ((changedConversation && !assignment) || changedEmptyScope) {
        closeRecord(state, record, events, uuid, now); record = null;
      } else if (assignment) {
        record.conversationRef = route.conversationRef;
        record.routeRevision++;
      }
    }
    if (!record) {
      if (Object.keys(state.tabs).length >= MAX_TABS || Object.keys(state.sessions).length >= MAX_RECORDS) {
        return { state, events, diagnostic: 'capacity' };
      }
      const sessionId = uuid();
      record = {
        sessionId, provider: route.provider, tabId: context.tabId,
        documentId: context.documentId, pageInstanceId: observation.pageInstanceId,
        routeRevision: 0, conversationRef: route.conversationRef,
        conversationTitle: '', requestPreview: '',
        sequence: 0, generation: 0, turnId: null, contentGenerationToken: null,
        lastContentSequence: 0, phase: 'idle', outcome: null, observation: 'fresh',
        lastObservationAt: observation.observedAt, announced: false, closed: false,
        unknownAfterReload: false,
      };
      state.sessions[sessionId] = record;
      state.tabs[context.tabId] = sessionId;
    }
    let newDocument = false;
    if (record.documentId !== context.documentId || record.pageInstanceId !== observation.pageInstanceId) {
      newDocument = true;
      record.documentId = context.documentId;
      record.pageInstanceId = observation.pageInstanceId;
      record.routeRevision++;
      record.lastContentSequence = 0;
      record.contentGenerationToken = null;
      record.unknownAfterReload = record.phase === 'running';
      record.conversationTitle = ''; record.requestPreview = '';
    }
    if (observation.contentSequence <= record.lastContentSequence) {
      return { state: original, events: [], diagnostic: 'duplicate_observation' };
    }
    record.lastContentSequence = observation.contentSequence;
    record.lastObservationAt = observation.observedAt;
    for (const field of ['conversationTitle', 'requestPreview']) {
      if (Object.hasOwn(observation, field)) record[field] = observation[field];
    }
    let kind = 'observation';
    if (observation.status === 'running') {
      if (!observation.generationToken) return { state: original, events: [], diagnostic: 'invalid_observation' };
      const continuingAfterReload = newDocument && record.phase === 'running';
      const newTurn = record.phase !== 'running'
        || (record.contentGenerationToken !== null && record.contentGenerationToken !== observation.generationToken);
      if (newTurn && !continuingAfterReload) {
        record.generation++; record.turnId = uuid();
      }
      if (!record.turnId) { record.generation++; record.turnId = uuid(); }
      record.contentGenerationToken = observation.generationToken;
      record.phase = 'running'; record.outcome = null; record.observation = 'fresh';
      record.unknownAfterReload = false; record.announced = true;
    } else if (observation.status === 'settled') {
      if (record.phase === 'running' && !newDocument && !record.unknownAfterReload
        && record.contentGenerationToken === observation.generationToken && record.turnId) {
        record.phase = 'settled'; record.outcome = observation.outcome;
        record.observation = 'fresh'; kind = 'terminal';
      } else if (record.phase === 'settled' && record.contentGenerationToken === observation.generationToken) {
        record.observation = 'fresh';
      } else {
        // Baseline after installing/reloading must not manufacture a finish.
        record.observation = record.phase === 'running' ? 'unsupported' : 'fresh';
      }
    } else if (observation.status === 'unknown') {
      record.observation = 'unsupported';
    } else if (record.phase === 'running') {
      record.unknownAfterReload = true;
      record.observation = 'unsupported';
    } else {
      record.observation = 'fresh';
      // Keep a known terminal until the next observed turn. Opening an old
      // conversation is never a new completion notification.
    }
    // A supported conversation is useful even before its first observed
    // generation. Baseline idle/settled samples still have no turn/terminal.
    if (observation.status !== 'unknown') record.announced = true;
    if (record.announced) events.push(makeEvent(state, record, kind, uuid, observation.observedAt));
    return { state, events, diagnostic: observation.status === 'unknown' ? 'unsupported' : null };
  }

  function closeTab(original, tabId, { uuid = defaultUuid, now = Date.now() } = {}) {
    const state = clone(original); const events = [];
    closeRecord(state, state.sessions[state.tabs[tabId]], events, uuid, now);
    return { state, events };
  }

  function invalidateTab(original, tabId, { uuid = defaultUuid, now = Date.now() } = {}) {
    const state = clone(original); const events = [];
    const record = state.sessions[state.tabs[tabId]];
    if (record?.announced) {
      record.observation = 'stale';
      record.routeRevision++;
      events.push(makeEvent(state, record, 'observation', uuid, record.lastObservationAt || now, true));
    }
    return { state, events };
  }

  function snapshot(original, { uuid = defaultUuid } = {}) {
    const state = clone(original); const events = [];
    for (const record of Object.values(state.sessions)) {
      if (!record.announced || record.closed) continue;
      record.observation = 'stale';
      events.push(makeEvent(state, record, 'observation', uuid, record.lastObservationAt, true));
    }
    return { state, events };
  }

  function recoverDurableEvents(original, events) {
    const state = clone(original);
    let changed = false;
    for (const event of events) {
      if (event.browserRunId !== state.browserRunId) continue;
      const record = state.sessions[event.sessionId];
      if (!record || record.provider !== event.provider || record.tabId !== event.tabId
        || event.sequence <= record.sequence) continue;
      // A local outbox write can have succeeded just before storage.session
      // failed. Reconcile that journal before snapshots or fresh observations,
      // so a repeated terminal cannot reuse its ID with a new timestamp.
      if (event.kind === 'terminal' && event.generation === record.generation
        && event.turnId === record.turnId && event.routeRevision >= record.routeRevision) {
        record.phase = 'settled'; record.outcome = event.outcome;
        record.observation = 'stale'; record.unknownAfterReload = false;
        record.sequence = event.sequence; record.latestEvent = { ...event };
        record.lastObservationAt = Math.max(record.lastObservationAt, event.observedAt);
        changed = true;
      } else if (event.kind === 'closed') {
        record.closed = true; record.observation = 'closed';
        record.sequence = event.sequence; record.latestEvent = { ...event };
        if (state.tabs[record.tabId] === record.sessionId) delete state.tabs[record.tabId];
        changed = true;
      }
    }
    return changed ? state : original;
  }

  function removeAcknowledgedClosed(original, event) {
    if (event.kind !== 'closed' || event.browserRunId !== original.browserRunId) return original;
    const record = original.sessions[event.sessionId];
    if (!record?.closed || record.sequence > event.sequence) return original;
    const state = clone(original); delete state.sessions[event.sessionId]; return state;
  }

  function focusMatches(state, request) {
    if (!request || request.browserRunId !== state.browserRunId || !utils.ID.test(request.requestId || '')
      || (request.noticeSequence !== null && (!Number.isSafeInteger(request.noticeSequence) || request.noticeSequence < 1))) return false;
    const record = state.sessions[request.sessionId];
    return !!record && !record.closed && state.tabs[request.tabId] === request.sessionId
      && record.tabId === request.tabId && record.pageInstanceId === request.pageInstanceId
      && record.routeRevision === request.routeRevision && record.conversationRef === request.conversationRef;
  }

  return { newState, validState, reduceObservation, closeTab, invalidateTab, snapshot,
    recoverDurableEvents, removeAcknowledgedClosed, focusMatches, MAX_TABS, MAX_RECORDS };
});
