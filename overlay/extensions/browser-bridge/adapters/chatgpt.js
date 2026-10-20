/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('../provider-utils.js') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriChatgptAdapter = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';
  // Experimental selectors, not an assertion about the current production DOM.
  // They must be confirmed on the target account/browser before employee use.
  const STOP = [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="生成を停止"]',
    'button[aria-label="生成を停止する"]',
  ];
  const COMPOSER = ['#prompt-textarea', '[data-testid="prompt-textarea"]'];
  const ASSISTANT = ['[data-message-author-role="assistant"]'];
  const ERROR = ['[data-testid="conversation-turn-error"]'];
  // An account reported no legacy composer/assistant markers, but a single
  // editable control plus a short stop button and aria-busy during generation.
  // Both activity signals disappeared afterwards. Keep this experimental path
  // separate: a generic Stop button or a busy indicator alone is insufficient.
  const SHORT_STOP = ['button[aria-label="Stop"]', 'button[aria-label="停止"]', 'button[aria-label="停止する"]'];
  const EDITOR = ['[contenteditable="true"]', '[contenteditable="plaintext-only"]', 'textarea'];
  const BUSY = ['[aria-busy="true"]'];

  function visibleElements(doc, selectors) {
    const found = new Set();
    for (const selector of selectors) {
      for (const element of doc.querySelectorAll(selector)) {
        if (utils.isVisible(element)) found.add(element);
      }
    }
    return [...found];
  }

  function alternateControls(doc) {
    const editors = visibleElements(doc, EDITOR).filter(element => !element.readOnly
      && element.getAttribute?.('readonly') == null && element.getAttribute?.('aria-readonly') !== 'true');
    const stops = visibleElements(doc, SHORT_STOP);
    return {
      // Do not guess which editor/stop belongs to the conversation when
      // multiple visible controls match. No text or DOM structure is exported.
      ready: editors.length === 1 && stops.length <= 1,
      stop: stops.length === 1 ? stops[0] : null,
      stopCount: stops.length,
      busy: !!utils.findVisible(doc, BUSY),
    };
  }

  function observe(doc, url) {
    const route = utils.routeForUrl(url);
    if (!route || route.provider !== 'chatgpt') return { supported: false, generating: false };
    const stop = utils.findVisible(doc, STOP);
    const composer = utils.findVisible(doc, COMPOSER);
    const assistant = utils.findVisible(doc, ASSISTANT);
    const alternate = alternateControls(doc);
    // The legacy path requires its text composer on a scoped landing page.
    // A stop control elsewhere on a GPT/project page alone is insufficient;
    // the alternate path below requires the independent paired evidence.
    const scopedStart = route.conversationRef === null && route.path.startsWith('/g/');
    const legacySupported = scopedStart ? !!composer : !!(stop || composer);
    const alternateGenerating = !stop && alternate.ready && !!alternate.stop && alternate.busy;
    const controlsIdle = alternate.ready && !stop && alternate.stopCount === 0 && !alternate.busy;
    // Half of the alternate activity evidence is ambiguous, including on
    // initial injection. Report unknown rather than calling that page idle.
    const supported = legacySupported || (alternate.ready && (alternateGenerating || controlsIdle));
    return {
      supported,
      generating: (legacySupported && !!stop) || alternateGenerating,
      ready: !!composer || alternate.ready,
      hasAssistant: !!assistant,
      error: !!utils.findVisible(doc, ERROR),
      // These hints stay inside the content script/controller. In particular,
      // a quiet editor must not settle a generation begun by the legacy path.
      generationSignal: alternateGenerating ? 'short_stop_busy' : null,
      controlsIdle,
      experimental: true,
    };
  }

  function isStopTarget(element, doc, url) {
    if (element?.closest?.(STOP.join(','))) return true;
    const route = utils.routeForUrl(url);
    if (!doc || route?.provider !== 'chatgpt') return false;
    const target = element?.closest?.(SHORT_STOP.join(','));
    if (!target) return false;
    if (utils.findVisible(doc, STOP)) return false;
    const alternate = alternateControls(doc);
    return alternate.ready && alternate.busy && target === alternate.stop;
  }

  return { provider: 'chatgpt', observe, isStopTarget,
    selectors: { STOP, COMPOSER, ASSISTANT, ERROR, SHORT_STOP, EDITOR, BUSY } };
});
