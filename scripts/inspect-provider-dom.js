/* SPDX-License-Identifier: AGPL-3.0-only */
(function expose(root, factory) {
  const inspect = factory();
  if (typeof module === "object" && module.exports) module.exports = inspect;
  else console.log(JSON.stringify(inspect(root.document, root.location.href), null, 2));
})(typeof globalThis === "object" ? globalThis : this, function createInspector() {
  "use strict";
  // Read-only manual browser diagnostic. No observer, network, storage or
  // clipboard access. Never read textContent/innerHTML, input values or titles.
  const cap = 200;
  const controls = {
    composer: '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder]',
    stop: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop response"], button[aria-label="Stop Response"], button[aria-label="生成を停止"], button[aria-label="生成を停止する"], button[aria-label="応答を停止"], button[aria-label="応答を停止する"]',
    shortStop: 'button[aria-label="Stop"], button[aria-label="停止"], button[aria-label="停止する"]',
    busy: '[aria-busy="true"]',
    streaming: '[data-is-streaming="true"]',
    assistantMarkers: '[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-is-streaming]',
    errors: '[data-testid="conversation-turn-error"], [data-testid="chat-error"]',
  };
  const attributes = ["data-conversation-id", "data-chat-id", "data-thread-id"];
  const elements = (doc, selector) => Array.from(doc.querySelectorAll(selector)).slice(0, cap);
  const visible = node => !node.hidden && node.getAttribute("aria-hidden") !== "true"
    && node.getClientRects().length > 0;
  const count = (doc, selector) => {
    const nodes = elements(doc, selector);
    return { sampled: nodes.length, visible: nodes.filter(visible).length, capped: nodes.length === cap };
  };
  return function inspect(doc, href) {
    const url = new URL(href);
    const providers = { "chatgpt.com": "chatgpt", "claude.ai": "claude" };
    const provider = url.protocol === "https:" && Object.hasOwn(providers, url.hostname) ? providers[url.hostname] : null;
    if (!provider) throw new Error("Open a normal ChatGPT or Claude conversation page.");
    const conversationId = url.pathname.match(/\/(?:c|chat)\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] || null;
    const roots = {};
    for (const attribute of attributes) {
      const nodes = elements(doc, `[${attribute}]`);
      const matching = conversationId ? nodes.filter(node => node.getAttribute(attribute) === conversationId) : [];
      roots[attribute] = { sampled: nodes.length, matchesCurrentRoute: matching.length,
        matchingRootsWithComposer: matching.filter(node => elements(node, controls.composer).some(visible)).length,
        matchingRootsWithStop: matching.filter(node => elements(node, controls.stop).some(visible)).length,
        capped: nodes.length === cap };
    }
    const canonicalLinks = elements(doc, 'link[rel="canonical"]');
    const canonicalMatchesRoute = canonicalLinks.some(node => {
      try {
        const target = new URL(node.getAttribute("href"), url);
        return target.origin === url.origin && target.pathname === url.pathname;
      } catch { return false; }
    });
    return { schema: 1, provider, routeKind: conversationId ? "conversation" : "other",
      visibility: ["visible", "hidden"].includes(doc.visibilityState) ? doc.visibilityState : "unknown",
      controls: Object.fromEntries(Object.entries(controls).map(([key, selector]) => [key, count(doc, selector)])),
      roots, canonical: { sampled: canonicalLinks.length, matchesCurrentRoute: canonicalMatchesRoute },
      provesConversationBinding: false };
  };
});
