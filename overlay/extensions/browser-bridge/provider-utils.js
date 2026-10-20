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
  const OBSERVATION_REJECTIONS = new Set(['paused', 'invalid_sender', 'old_document',
    'invalid_observation', 'old_observation', 'duplicate_observation', 'capacity',
    'outbox_full', 'storage_failed', 'local_data_invalid', 'tab_unavailable', 'observation_failed']);

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

  function safeObservation(input) {
    if (!input || input.type !== 'mori.observation' || input.v !== 1) return null;
    if (!ID.test(input.pageInstanceId || '') || !Number.isSafeInteger(input.contentSequence)
      || input.contentSequence < 1 || !Number.isSafeInteger(input.observedAt) || input.observedAt < 1) return null;
    if (!['idle', 'running', 'settled', 'unknown'].includes(input.status)) return null;
    if (input.generationToken !== null && !ID.test(input.generationToken || '')) return null;
    if (![null, 'interrupted', 'error', 'unverified'].includes(input.outcome)) return null;
    if (input.status === 'settled' && (!input.generationToken || !input.outcome)) return null;
    if (input.status !== 'settled' && input.outcome !== null) return null;
    // Project only this allowlist. A compromised page cannot smuggle content
    // through additional properties into either storage or the local wire.
    return {
      pageInstanceId: input.pageInstanceId,
      contentSequence: input.contentSequence,
      observedAt: input.observedAt,
      status: input.status,
      generationToken: input.generationToken,
      outcome: input.outcome,
    };
  }

  return { ID, URL_PATTERNS, providerForUrl, routeForUrl, sameRoute, canAssignConversation,
    isVisible, findVisible, safeObservation, safeObservationAck };
});
