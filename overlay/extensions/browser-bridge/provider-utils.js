/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriProviderUtils = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const CONVERSATION_ID = /^[A-Za-z0-9-]{1,128}$/;
  const URL_PATTERNS = ['https://chatgpt.com/*', 'https://claude.ai/*'];

  function routeForUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const provider = url.hostname === 'chatgpt.com' ? 'chatgpt'
      : url.hostname === 'claude.ai' ? 'claude' : null;
    if (!provider) return null;
    const rootPaths = provider === 'chatgpt' ? ['/', ''] : ['/', '/new', ''];
    if (rootPaths.includes(url.pathname)) {
      return { provider, path: url.pathname || '/', conversationRef: null };
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

  return { ID, URL_PATTERNS, routeForUrl, sameRoute, isVisible, findVisible, safeObservation };
});
