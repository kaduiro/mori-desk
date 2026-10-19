/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('../provider-utils.js') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriClaudeAdapter = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';
  const STOP = [
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop Response"]',
    'button[aria-label="応答を停止"]',
    'button[aria-label="応答を停止する"]',
    'button[data-testid="stop-button"]',
  ];
  const COMPOSER = ['[contenteditable="true"][data-placeholder]', '[contenteditable="true"][role="textbox"]'];
  const ASSISTANT = ['[data-is-streaming]', '[data-testid="assistant-message"]', '.font-claude-response'];
  const ERROR = ['[data-testid="chat-error"]'];

  function observe(doc, url) {
    const route = utils.routeForUrl(url);
    if (!route || route.provider !== 'claude') return { supported: false, generating: false };
    const stop = utils.findVisible(doc, STOP);
    const streaming = utils.findVisible(doc, ['[data-is-streaming="true"]']);
    const composer = utils.findVisible(doc, COMPOSER);
    return {
      supported: !!(stop || composer || streaming),
      generating: !!(stop || streaming),
      ready: !!composer,
      hasAssistant: !!utils.findVisible(doc, ASSISTANT),
      error: !!utils.findVisible(doc, ERROR),
      experimental: true,
    };
  }

  function isStopTarget(element) {
    return !!element?.closest?.(STOP.join(','));
  }

  return { provider: 'claude', observe, isStopTarget, selectors: { STOP, COMPOSER, ASSISTANT, ERROR } };
});
