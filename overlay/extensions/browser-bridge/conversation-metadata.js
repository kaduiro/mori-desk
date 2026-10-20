/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports
    ? require('./provider-utils.js') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriConversationMetadata = api;
})(typeof globalThis === 'object' ? globalThis : this, function (utils) {
  'use strict';
  const USER = {
    chatgpt: '[data-message-author-role="user"]',
    claude: '[data-testid="user-message"], [data-message-author-role="user"]',
  };
  const EDITOR = 'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
  const NAVIGATION = 'nav, aside, [data-testid="history"], [data-testid="chat-history"], [data-sidebar]';
  const OMIT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'OPTION']);
  const BLOCK_TAGS = new Set(['BR', 'P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // Called only with an exact-route conversation link or the latest submitted
  // user-message element. Never read a whole page, assistant message, input
  // value, HTML, or an editable draft (including an edit inside a user bubble).
  function boundedText(root) {
    if (!root || root.closest?.(EDITOR)) return '';
    let text = '';
    let visited = 0;
    function visit(node) {
      if (!node || ++visited > 2048 || text.length >= 4096) return;
      if (node.nodeType === 3) { text += (node.nodeValue || '').slice(0, 4096 - text.length); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName?.toUpperCase();
      const role = node.getAttribute?.('role');
      const editable = node.getAttribute?.('contenteditable');
      if (OMIT_TAGS.has(tag) || node.hidden
        || node.getAttribute?.('aria-hidden') === 'true' || role === 'textbox'
        || (node !== root && role === 'button')
        || (editable !== null && editable !== undefined && editable !== 'false')
        || node.getAttribute?.('data-message-author-role') === 'assistant'
        || node.getAttribute?.('data-testid') === 'assistant-message') return;
      if (BLOCK_TAGS.has(tag)) text += ' ';
      for (const child of node.childNodes || []) {
        if (visited >= 2048 || text.length >= 4096) break;
        visit(child);
      }
      if (BLOCK_TAGS.has(tag)) text += ' ';
    }
    visit(root);
    return utils.metadataText(text);
  }

  function conversationLinks(doc, url) {
    const links = [];
    for (const link of doc.querySelectorAll('a[href]')) {
      // A conversation URL quoted inside a message is not its title. Only
      // history/navigation links with the exact canonical route are eligible.
      if (!link.closest?.(NAVIGATION) && link.getAttribute?.('data-sidebar-item') == null
        && !/^history-item-/.test(link.getAttribute?.('data-testid') || '')) continue;
      let target;
      try { target = utils.routeForUrl(new URL(link.getAttribute('href'), url).href); }
      catch (_) { continue; }
      if (target?.conversationRef) links.push({ link, route: target });
    }
    return links;
  }

  function titleForRoute(links, route) {
    if (!route?.conversationRef) return '';
    for (const { link, route: target } of links) {
      if (!utils.sameRoute(target, route)) continue;
      const title = boundedText(link);
      if (title) return title;
    }
    // A generic document.title/header can still describe the previous SPA
    // conversation. Without an exact route binding, report unavailable.
    return '';
  }

  function userMessages(doc, route) {
    if (!route) return [];
    return [...doc.querySelectorAll(USER[route.provider])].filter(utils.isVisible);
  }

  function createReader() {
    let initialized = false;
    let route = null;
    let previousNodes = [];
    let previousPreview = '';
    let fence = null;
    let knownKeys = [];
    return {
      knownConversationKeys() { return [...knownKeys]; },
      sample(doc, url, { assignedNewConversation = false } = {}) {
        const current = utils.routeForUrl(url);
        const links = current ? conversationLinks(doc, url) : [];
        knownKeys = links.map(({ route: target }) => `${target.provider}:${target.conversationRef}`);
        const nodes = userMessages(doc, current);
        const latest = nodes.at(-1);
        const preview = latest ? boundedText(latest) : '';
        if (initialized && !utils.sameRoute(route, current) && !assignedNewConversation) {
          // Navigation can change the URL before React replaces any messages.
          // Keep only references to the old submitted nodes, plus its already
          // authorized latest excerpt, and fence them from the new route.
          fence ||= { nodes: new WeakSet(), previews: new Set() };
          for (const node of previousNodes) fence.nodes.add(node);
          if (previousPreview) fence.previews.add(previousPreview);
          // With no previous message sample, the currently rendered nodes are
          // ambiguous too. A later replacement must establish the new view.
          if (!previousNodes.length) for (const node of nodes) fence.nodes.add(node);
        }
        initialized = true; route = current;
        let requestPreview = preview;
        if (!current || !current.conversationRef) requestPreview = '';
        if (fence) {
          if (!latest || fence.nodes.has(latest) || fence.previews.has(preview)) requestPreview = '';
          else if (preview) fence = null;
        }
        previousNodes = nodes;
        previousPreview = preview;
        return { conversationTitle: titleForRoute(links, current), requestPreview };
      },
    };
  }

  return { createReader };
});
