/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./provider-utils.js') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriOutbox = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';
  const MAX_EVENTS = 200;
  const MAX_BYTES = 512 * 1024;
  const FIELDS = ['type', 'v', 'eventId', 'browserRunId', 'sessionId', 'sequence', 'kind', 'provider',
    'tabId', 'pageInstanceId', 'routeRevision', 'conversationRef', 'turnId', 'generation',
    'phase', 'outcome', 'observation', 'observedAt', 'replay'];
  function eventValid(event) {
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
      || !Number.isFinite(event.observedAt) || typeof event.replay !== 'boolean') return false;
    if (event.conversationRef !== null) {
      const domain = event.provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
      const route = utils.routeForUrl(`https://${domain}${event.conversationRef}`);
      if (!route || route.conversationRef !== event.conversationRef) return false;
    }
    return event.kind !== 'terminal' || (event.phase === 'settled' && event.turnId !== null
      && event.generation >= 1 && event.outcome !== null);
  }
  function valid(outbox) {
    return !!outbox && outbox.v === 1 && Array.isArray(outbox.events)
      && outbox.events.length <= MAX_EVENTS && outbox.events.every(eventValid)
      && new TextEncoder().encode(JSON.stringify(outbox)).byteLength <= MAX_BYTES;
  }
  function append(original, events) {
    const next = { v: 1, events: [...original.events] };
    for (const event of events) {
      if (!eventValid(event)) throw new Error('invalid_outbox_event');
      const existing = next.events.find(item => item.eventId === event.eventId
        && item.sessionId === event.sessionId && item.browserRunId === event.browserRunId);
      if (existing) continue;
      next.events.push({ ...event });
    }
    if (!valid(next)) throw new Error('outbox_full');
    return next;
  }
  function acknowledge(original, ack) {
    return { v: 1, events: original.events.filter(event => !(event.eventId === ack.eventId
      && event.browserRunId === ack.browserRunId && event.sessionId === ack.sessionId
      && event.sequence === ack.sequence)) };
  }
  return { valid, append, acknowledge, eventValid, MAX_EVENTS, MAX_BYTES };
});
