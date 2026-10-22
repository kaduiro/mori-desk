/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriProviderUtils = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const CONVERSATION_ID = /^[A-Za-z0-9-]{1,128}$/;
  const CHATGPT_SCOPE = /^g-[A-Za-z0-9_-]{1,160}$/;
  const URL_PATTERNS = ['https://chatgpt.com/*', 'https://claude.ai/*'];
  const MAX_METADATA_LENGTH = 160;
  const METADATA_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
  const OBSERVATION_REJECTIONS = new Set(['paused', 'invalid_sender', 'old_document',
    'invalid_observation', 'old_observation', 'duplicate_observation', 'capacity',
    'outbox_full', 'storage_failed', 'local_data_invalid', 'tab_unavailable', 'observation_failed',
    'binding_unconfirmed', 'lease_invalid', 'lease_expired', 'attempt_expired', 'observer_version',
    'initialization_failed', 'registration_failed']);

  const LEASE_FIELDS = ['workerEpoch', 'leaseId', 'bindingEpoch'];
  function safeLease(input) {
    if (!input || LEASE_FIELDS.some(field => typeof input[field] !== 'string' || !ID.test(input[field]))) return null;
    return Object.fromEntries(LEASE_FIELDS.map(field => [field, input[field]]));
  }

  function safeObserverRegister(input) {
    if (!input || input.type !== 'mori.observer.register' || input.v !== 1
      || typeof input.pageInstanceId !== 'string' || !ID.test(input.pageInstanceId)
      || input.observerVersion !== '0.1.8'
      || !Object.hasOwn(input, 'attemptId')
      || (input.attemptId !== null && (typeof input.attemptId !== 'string' || !ID.test(input.attemptId)))
      || Object.keys(input).some(key => !['type', 'v', 'pageInstanceId', 'observerVersion', 'attemptId'].includes(key))) return null;
    return { pageInstanceId: input.pageInstanceId, observerVersion: input.observerVersion, attemptId: input.attemptId };
  }

  function safeObserverIdentity(input) {
    if (!input || input.ok !== true || input.v !== 1 || input.observerVersion !== '0.1.8'
      || typeof input.pageInstanceId !== 'string' || !ID.test(input.pageInstanceId)
      || !['confirmed', 'unconfirmed'].includes(input.binding?.state)
      || typeof input.binding.epoch !== 'string' || !ID.test(input.binding.epoch)) return null;
    let route = null;
    if (input.route !== null) {
      const value = input.route;
      if (!value || !['chatgpt', 'claude'].includes(value.provider) || typeof value.path !== 'string') return null;
      const parsed = routeForUrl(`https://${value.provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai'}${value.path}`);
      if (!parsed || parsed.path !== value.path || parsed.conversationRef !== value.conversationRef) return null;
      route = parsed;
    }
    const lease = input.lease === null ? null : safeLease(input.lease);
    if (input.lease !== null && !lease) return null;
    if (lease && (input.binding.state !== 'confirmed' || lease.bindingEpoch !== input.binding.epoch)) return null;
    return { ok: true, v: 1, observerVersion: input.observerVersion, pageInstanceId: input.pageInstanceId,
      route, binding: { state: input.binding.state, epoch: input.binding.epoch }, lease };
  }

  function safeObservationAck(value) {
    if (value?.ok === true) return { ok: true, reason: null };
    if (value?.ok === false) return { ok: false,
      reason: OBSERVATION_REJECTIONS.has(value.reason) ? value.reason : 'observation_failed' };
    // Absence of a receipt is not acceptance. Never forward exception strings
    // or arbitrary properties from the messaging API into a diagnostic.
    return { ok: null, reason: value?.ok === null && value.reason === 'worker_unavailable'
      ? 'worker_unavailable' : 'ack_unavailable' };
  }

  function providerUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const provider = url.hostname === 'chatgpt.com' ? 'chatgpt'
      : url.hostname === 'claude.ai' ? 'claude' : null;
    if (!provider) return null;
    return { url, provider };
  }

  function providerForUrl(value) { return providerUrl(value)?.provider || null; }

  function routeForUrl(value) {
    const parsed = providerUrl(value);
    if (!parsed) return null;
    const { url, provider } = parsed;
    const rootPaths = provider === 'chatgpt' ? ['/', ''] : ['/', '/new', ''];
    if (rootPaths.includes(url.pathname)) {
      return { provider, path: url.pathname || '/', conversationRef: null };
    }
    if (provider === 'chatgpt' && url.pathname.startsWith('/g/')) {
      const segments = url.pathname.split('/');
      if (!CHATGPT_SCOPE.test(segments[2] || '')) return null;
      if (segments.length === 3) {
        // This local-only path distinguishes empty GPT/project pages during
        // SPA navigation. It must never be stored or sent to the desktop.
        return { provider, path: url.pathname, conversationRef: null };
      }
      if (segments.length !== 5 || segments[3] !== 'c' || !CONVERSATION_ID.test(segments[4])) return null;
      // Project/GPT scope segments may contain names. Only the opaque
      // conversation identifier crosses the observation/desktop boundary.
      const conversationRef = '/c/' + segments[4];
      return { provider, path: conversationRef, conversationRef };
    }
    const prefix = provider === 'chatgpt' ? '/c/' : '/chat/';
    if (!url.pathname.startsWith(prefix)) return null;
    const id = url.pathname.slice(prefix.length);
    if (!CONVERSATION_ID.test(id)) return null;
    return { provider, path: prefix + id, conversationRef: prefix + id };
  }

  function sameRoute(a, b) {
    return !!a && !!b && a.provider === b.provider && a.path === b.path;
  }

  function canAssignConversation(from, nextUrl) {
    const next = routeForUrl(nextUrl);
    if (!from || !next || from.provider !== next.provider
      || from.conversationRef !== null || next.conversationRef === null) return false;
    if (from.provider !== 'chatgpt') return true;
    const currentPath = providerUrl(nextUrl).url.pathname;
    // Preserve a newly assigned conversation only within the same local
    // scope. Selecting an existing conversation in another project/GPT is a
    // navigation, even when the previous conversation still had no ID.
    return from.path.startsWith('/g/')
      ? currentPath.startsWith(from.path + '/c/') : currentPath.startsWith('/c/');
  }

  function isVisible(element) {
    if (!element || element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
    // No computed text, prompt, reply, or HTML is inspected. Synthetic fixtures
    // may omit geometry; live DOM elements must have a rendered rectangle.
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    return true;
  }

  function findVisible(doc, selectors) {
    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        if (isVisible(element)) return element;
      }
    }
    return null;
  }

  function metadataText(value) {
    if (typeof value !== 'string') return '';
    // Keep meaningful Unicode (including emoji ZWJ sequences), but discard
    // control/bidi characters and lone UTF-16 surrogates. Whitespace is
    // collapsed before controls are removed so line breaks separate words.
    const singleLine = value.replace(/\s+/gu, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
      .replace(/\s+/gu, ' ').trim();
    let text = '';
    for (const character of singleLine) {
      if (character.length === 1 && /[\ud800-\udfff]/u.test(character)) continue;
      if (text.length + character.length > MAX_METADATA_LENGTH) break;
      text += character;
    }
    return text.replace(/\s+/gu, ' ').trim();
  }

  function validMetadataText(value) {
    return typeof value === 'string' && value.length <= MAX_METADATA_LENGTH
      && !METADATA_CONTROLS.test(value) && value === value.replace(/\s+/gu, ' ').trim()
      && Array.from(value).every(character => character.length === 2 || !/[\ud800-\udfff]/u.test(character));
  }

  function safeObservation(input) {
    if (!input || input.type !== 'mori.observation' || input.v !== 1) return null;
    if (!ID.test(input.pageInstanceId || '') || !Number.isSafeInteger(input.contentSequence)
      || input.contentSequence < 1 || !Number.isSafeInteger(input.observedAt) || input.observedAt < 1) return null;
    if (!['idle', 'running', 'settled', 'unknown'].includes(input.status)) return null;
    if (input.generationToken !== null && !ID.test(input.generationToken || '')) return null;
    if (![null, 'interrupted', 'error', 'unverified'].includes(input.outcome)) return null;
    if (input.status === 'settled' && (!input.generationToken || !input.outcome)) return null;
    if (input.status !== 'settled' && input.outcome !== null) return null;
    for (const field of ['conversationTitle', 'requestPreview']) {
      if (Object.hasOwn(input, field) && !validMetadataText(input[field])) return null;
    }
    const hasLease = LEASE_FIELDS.some(field => Object.hasOwn(input, field));
    const lease = hasLease ? safeLease(input) : null;
    if (hasLease && !lease) return null;
    // Project only this allowlist. A compromised page cannot smuggle content
    // through additional properties into either storage or the local wire.
    return {
      pageInstanceId: input.pageInstanceId,
      contentSequence: input.contentSequence,
      observedAt: input.observedAt,
      status: input.status,
      generationToken: input.generationToken,
      outcome: input.outcome,
      ...(lease || {}),
      ...(Object.hasOwn(input, 'conversationTitle') ? { conversationTitle: input.conversationTitle } : {}),
      ...(Object.hasOwn(input, 'requestPreview') ? { requestPreview: input.requestPreview } : {}),
    };
  }

  return { ID, URL_PATTERNS, providerForUrl, routeForUrl, sameRoute, canAssignConversation,
    isVisible, findVisible, metadataText, validMetadataText, MAX_METADATA_LENGTH,
    safeObservation, safeObservationAck, safeLease, safeObserverRegister, safeObserverIdentity };
});
