/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./provider-utils.js') : root.MoriProviderUtils,
    typeof module === 'object' && module.exports ? require('./monitoring-contract') : root.MoriMonitoringContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriOutbox = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils, contract) {
  'use strict';
  const MAX_EVENTS = 200;
  const MAX_BYTES = 512 * 1024;
  const FIELDS = ['type', 'v', 'eventId', 'browserRunId', 'sessionId', 'sequence', 'kind', 'provider',
    'tabId', 'pageInstanceId', 'routeRevision', 'conversationRef', 'turnId', 'generation',
    'phase', 'outcome', 'observation', 'observedAt', 'replay', 'conversationTitle', 'requestPreview'];
  function eventValid(event) {
    if (event?.type === 'scope.event') {
      if (!contract.keys(event, [...FIELDS, 'schema', 'scope', 'gap']) || event.schema !== 2 || !contract.validScope(event.scope)) return false;
      const { schema, scope, gap, ...body } = event;
      if (scope.kind === 'view' && (body.conversationRef !== null || body.conversationTitle !== '' || body.requestPreview !== '')
        || scope.kind === 'conversation' && body.conversationRef === null) return false;
      if (event.kind === 'gap') {
        if (!contract.keys(gap, ['turnId', 'reason', 'observedAt']) || gap.turnId !== event.turnId
          || !contract.id(gap.turnId) || !contract.GAP_REASONS.includes(gap.reason)
          || !Number.isSafeInteger(gap.observedAt) || gap.observedAt < 1 || event.observation === 'fresh') return false;
        return eventValid({ ...body, type: 'event', kind: 'closed', observation: 'closed' });
      }
      return gap === null && eventValid({ ...body, type: 'event' });
    }
    if (!event || Object.keys(event).some(key => !FIELDS.includes(key))
      || event.type !== 'event' || event.v !== 1 || !['terminal', 'closed'].includes(event.kind)) return false;
    for (const field of ['eventId', 'browserRunId', 'sessionId', 'pageInstanceId']) {
      if (!utils.ID.test(event[field] || '')) return false;
    }
    if (event.turnId !== null && !utils.ID.test(event.turnId || '')) return false;
    for (const field of ['tabId', 'routeRevision', 'generation', 'sequence']) {
      if (!Number.isSafeInteger(event[field]) || event[field] < (field === 'sequence' ? 1 : 0)) return false;
    }
    if (!['chatgpt', 'claude'].includes(event.provider) || !['idle', 'running', 'settled'].includes(event.phase)
      || ![null, 'interrupted', 'error', 'unverified'].includes(event.outcome)
      || !['fresh', 'stale', 'closed', 'unsupported'].includes(event.observation)
      || !Number.isSafeInteger(event.observedAt) || event.observedAt < 1 || typeof event.replay !== 'boolean'
      || event.kind === 'closed' && event.observation !== 'closed') return false;
    for (const field of ['conversationTitle', 'requestPreview']) {
      if (Object.hasOwn(event, field) && !utils.validMetadataText(event[field])) return false;
    }
    if (event.conversationRef !== null) {
      const domain = event.provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
      const route = utils.routeForUrl(`https://${domain}${event.conversationRef}`);
      if (!route || route.conversationRef !== event.conversationRef) return false;
    }
    return event.kind !== 'terminal' || (event.phase === 'settled' && event.turnId !== null
      && event.generation >= 1 && event.outcome !== null);
  }
  function valid(outbox) {
    return !!outbox && [1, 2].includes(outbox.v) && Array.isArray(outbox.events)
      && outbox.events.length <= MAX_EVENTS && outbox.events.every(eventValid)
      && new TextEncoder().encode(JSON.stringify(outbox)).byteLength <= MAX_BYTES;
  }
  function append(original, events, privateTap) {
    const next = { v: original.v, events: [...original.events] };
    for (const event of events) {
      if (!eventValid(event)) throw new Error('invalid_outbox_event');
      const existing = next.events.find(item => item.eventId === event.eventId
        && item.sessionId === event.sessionId && item.browserRunId === event.browserRunId);
      if (existing) {
        const fingerprint = value => JSON.stringify(Object.keys(value).filter(k => k !== 'replay').sort().map(k => [k, value[k]]));
        if (fingerprint(existing) !== fingerprint(event)) throw new Error('event_id_conflict');
        try { privateTap?.clone?.(event, existing, 'outbox_retained'); } catch (_) {}
        continue;
      }
      const copied = { ...event };
      next.events.push(copied);
      try { privateTap?.clone?.(event, copied, 'outbox_append'); } catch (_) {}
      if (event.type === 'scope.event') next.v = 2;
    }
    if (!valid(next)) throw new Error('outbox_full');
    return next;
  }
  function acknowledge(original, ack) {
    return { v: original.v, events: original.events.filter(event => !(event.eventId === ack.eventId
      && event.browserRunId === ack.browserRunId && event.sessionId === ack.sessionId
      && event.sequence === ack.sequence && (event.type === 'scope.event' ? ack.type === 'scope.event.ack' && ack.schema === 2 : ack.type === 'event.ack' || ack.type === undefined))) };
  }
  return { valid, append, acknowledge, eventValid, MAX_EVENTS, MAX_BYTES };
});
