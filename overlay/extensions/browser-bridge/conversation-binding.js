/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const utils = typeof module === 'object' && module.exports ? require('./provider-utils') : root.MoriProviderUtils;
  const api = factory(utils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriConversationBinding = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';

  // A URL, selected sidebar link, stable delay, or a replaced DOM node does
  // not prove that visible controls/messages belong to that conversation.
  // No provider-specific proof has yet been verified against an actual page.
  // Keep the unreleased candidate quarantined until that separate acceptance
  // gate supplies a reviewed provider verifier. There is deliberately no DOM
  // attribute, option, timer, or page-message switch to bypass this boundary.
  function createTracker({ uuid = () => crypto.randomUUID() } = {}) {
    let route = null;
    let epoch = uuid();
    function sample(_document, href) {
      const next = utils.routeForUrl(href);
      if (!utils.sameRoute(route, next) && (route || next)) { route = next; epoch = uuid(); }
      return { state: 'unconfirmed', epoch };
    }
    return { sample };
  }
  return { createTracker };
});
