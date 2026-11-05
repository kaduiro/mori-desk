/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const utils = typeof module === 'object' && module.exports ? require('./provider-utils') : root.MoriProviderUtils;
  const api = factory(utils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriConversationBinding = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';

  // Verified in installed Chrome on 2026-10-25. Read only provider-owned
  // structural attributes: never infer ownership from URL/sidebar/timing alone.
  const CHATGPT_TRANSCRIPT = '[data-chatgpt-conversation-selection-target]';
  const CHATGPT_COMPOSER = '[data-map-composer-conversation]';
  const CLAUDE_ROOT = '[data-testid="bardhub-claudechat-root"]';
  function visible(root, selector) {
    return [...root.querySelectorAll(selector)].filter(utils.isVisible);
  }
  function verify(doc, route, allowView = false) {
    if (!route || doc.prerendering || doc.readyState === 'loading') return null;
    const mains = visible(doc, 'main');
    if (mains.length !== 1) return null;
    const main = mains[0];
    const id = route.conversationRef?.split('/').pop();
    if (route.provider === 'chatgpt') {
      const transcripts = visible(main, CHATGPT_TRANSCRIPT);
      // The mapping wrapper uses display:contents (no own rectangle). Its
      // visible text composer, rather than wrapper geometry, proves presence.
      const composers = [...main.querySelectorAll(CHATGPT_COMPOSER)].filter(node =>
        !node.hidden && node.getAttribute('aria-hidden') !== 'true'
        && visible(node, '[contenteditable="true"][role="textbox"]').length);
      if (transcripts.length !== 1 || composers.length !== 1) return null;
      const transcript = transcripts[0], composer = composers[0];
      const ownerId = transcript.getAttribute('data-chatgpt-conversation-selection-target');
      const kind = id && ownerId === id ? 'conversation'
        : allowView && /^local-chatgpt:[A-Za-z0-9-]{1,128}$/.test(ownerId || '') ? 'view' : null;
      if (!kind || composer.getAttribute('data-map-composer-conversation') !== ownerId
        || visible(composer, 'form[data-chatgpt-composer][data-composer-placement="thread"]').length !== 1
        || visible(composer, '[contenteditable="true"][role="textbox"]').length !== 1) return null;
      // Reject mixed/old rendered messages during an SPA transition.
      if (visible(transcript, '[data-chatgpt-selection-conversation-id]')
        .some(node => node.getAttribute('data-chatgpt-selection-conversation-id') !== ownerId)) return null;
      const activity = transcript.closest('[data-thread-user-message-navigation-content]');
      if (!activity) return null;
      return { roots: [transcript, composer], main, key: ownerId, kind,
        form: visible(composer, 'form[data-chatgpt-composer][data-composer-placement="thread"]')[0] };
    }
    const roots = visible(main, CLAUDE_ROOT);
    if (roots.length !== 1) return null;
    const root = roots[0];
    if (root.getAttribute('data-conv-id') !== id || root.getAttribute('data-hub-ready') !== '1'
      || root.getAttribute('data-hub-awaiting-creation') !== '0'
      || visible(root, '[data-testid="chat-input"][contenteditable="true"][role="textbox"]').length !== 1
      || visible(main, '[data-testid="chat-stale-nav-shield"], [data-testid="chat-message-skeleton"]').length) return null;
    return { roots: [root], main, key: id, kind: 'conversation' };
  }

  function createTracker({ uuid = () => crypto.randomUUID(), detailed = false, allowView = false } = {}) {
    let route = null;
    let epoch = uuid();
    let proof = null;
    let viewEpoch = uuid();
    let lastOwner = null, blockedOwner = null;
    function sample(document, href) {
      const next = utils.routeForUrl(href);
      let candidate = null;
      try { candidate = verify(document, next, allowView); } catch (_) { /* Unknown layout stays closed. */ }
      const changed = !utils.sameRoute(route, next) && !!(route || next);
      // A local-ID view proves the currently rendered scope, not its URL.
      // Never carry that view over a route change while the old DOM lingers.
      if (changed && route && lastOwner) blockedOwner = lastOwner;
      if (candidate?.kind === 'view' && candidate.key === blockedOwner) candidate = null;
      if (candidate && candidate.key !== blockedOwner) blockedOwner = null;
      if (changed || !!proof !== !!candidate || (proof && candidate
        && (proof.key !== candidate.key || proof.kind !== candidate.kind || proof.main !== candidate.main || proof.roots.length !== candidate.roots.length
          || proof.roots.some((node, index) => node !== candidate.roots[index])))) { epoch = uuid(); viewEpoch = uuid(); }
      route = next; proof = candidate;
      if (candidate) lastOwner = candidate.key;
      const result = { state: proof ? 'confirmed' : 'unconfirmed', epoch };
      if (detailed) Object.assign(result, { kind: proof?.kind || 'unknown', viewEpoch,
        reason: proof ? null : document.readyState === 'loading' ? 'loading'
          : !next ? 'unsupported_route' : !next.conversationRef ? 'conversation_id_pending' : 'scope_unconfirmed' });
      return result;
    }
    // DOM references stay inside this content script. Identity/wire messages
    // contain only state and epoch. Adapters cannot inspect unrelated panels.
    function scope(onSubject, onSubjectFailure) {
      if (!proof) return null;
      const roots = [...proof.roots];
      const form = proof.form;
      // A private development caller may inspect the exact subject captured by
      // this facade, including form changes that do not change the epoch.
      if (typeof onSubject === 'function') {
        try { onSubject({ main: proof.main, roots: [...roots], form: form || null,
          key: proof.key, kind: proof.kind, epoch, viewEpoch }); } catch (_) { try { onSubjectFailure?.(); } catch (_) {} }
      }
      return { querySelectorAll: selector => {
        const controls = /button|contenteditable|textarea|prompt-textarea/.test(selector);
        const sources = form ? (controls ? [form] : [roots[0]]) : roots;
        return [...new Set(sources.flatMap(root => [...root.querySelectorAll(selector)]))]
          .filter(node => !form || !controls || node.closest?.('form[data-chatgpt-composer]') === form);
      } };
    }
    return { sample, scope };
  }
  return { createTracker };
});
