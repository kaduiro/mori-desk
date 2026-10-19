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

  function observe(doc, url) {
    const route = utils.routeForUrl(url);
    if (!route || route.provider !== 'chatgpt') return { supported: false, generating: false };
    const stop = utils.findVisible(doc, STOP);
    const composer = utils.findVisible(doc, COMPOSER);
    const assistant = utils.findVisible(doc, ASSISTANT);
    return {
      supported: !!(stop || composer),
      generating: !!stop,
      ready: !!composer,
      hasAssistant: !!assistant,
      error: !!utils.findVisible(doc, ERROR),
      experimental: true,
    };
  }

  function isStopTarget(element) {
    return !!element?.closest?.(STOP.join(','));
  }

  return { provider: 'chatgpt', observe, isStopTarget, selectors: { STOP, COMPOSER, ASSISTANT, ERROR } };
});
