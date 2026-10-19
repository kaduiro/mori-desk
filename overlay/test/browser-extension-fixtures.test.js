const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument } = require('htmlparser2');
const chatgpt = require('../extensions/browser-bridge/adapters/chatgpt');
const claude = require('../extensions/browser-bridge/adapters/claude');
const { createController } = require('../extensions/browser-bridge/observation-controller');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Synthetic HTML fixtures only. This tiny selector/visibility harness covers
// the simple selector vocabulary used by these adapters; it is not evidence
// that either production site still uses these attributes.
function fixtureDocument(html) {
  const root = parseDocument(html);
  const elements = [];
  function visit(node) {
    if (node.type === 'tag') elements.push(node);
    for (const child of node.children || []) visit(child);
  }
  visit(root);
  function matches(node, selector) {
    const tag = selector.match(/^[a-z][a-z0-9-]*/i)?.[0];
    if (tag && node.name !== tag) return false;
    const id = selector.match(/^#([A-Za-z0-9_-]+)/)?.[1];
    if (id && node.attribs.id !== id) return false;
    const className = selector.match(/^\.([A-Za-z0-9_-]+)/)?.[1];
    if (className && !(node.attribs.class || '').split(/\s+/).includes(className)) return false;
    for (const [, name, expected] of selector.matchAll(/\[([a-z0-9-]+)(?:="([^"]*)")?\]/gi)) {
      if (!Object.hasOwn(node.attribs, name) || (expected !== undefined && node.attribs[name] !== expected)) return false;
    }
    return true;
  }
  function visible(node) {
    for (let current = node; current; current = current.parent) {
      if (Object.hasOwn(current.attribs || {}, 'hidden')
        || current.attribs?.['aria-hidden'] === 'true' || /display\s*:\s*none/.test(current.attribs?.style || '')) return false;
    }
    return true;
  }
  const wrap = node => ({
    hidden: Object.hasOwn(node.attribs, 'hidden'),
    getAttribute: name => node.attribs[name] ?? null,
    getClientRects: () => visible(node) ? [{}] : [],
    get textContent() { throw new Error('reply text must not be read'); },
    get innerHTML() { throw new Error('HTML must not be read'); },
  });
  return { querySelectorAll: selector => elements.filter(node => matches(node, selector)).map(wrap) };
}

test('synthetic ChatGPT fixture tracks visible generation controls without reading the reply', () => {
  const running = fixtureDocument('<main><article data-message-author-role="assistant">PRIVATE REPLY</article>'
    + '<div id="prompt-textarea" contenteditable="true">PRIVATE PROMPT</div><button data-testid="stop-button">Stop</button></main>');
  const stopped = fixtureDocument('<main><article data-message-author-role="assistant">PRIVATE REPLY</article>'
    + '<div id="prompt-textarea" contenteditable="true"></div><button hidden data-testid="stop-button">Old control</button></main>');
  assert.equal(chatgpt.observe(running, 'https://chatgpt.com/c/test').generating, true);
  const result = chatgpt.observe(stopped, 'https://chatgpt.com/c/test');
  assert.equal(result.generating, false);
  assert.equal(result.hasAssistant, true);
  assert.equal(result.experimental, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('synthetic Claude streaming attribute and stop control both indicate work, never proven completion', () => {
  const doc = fixtureDocument('<main><div data-is-streaming="true">PRIVATE REPLY</div>'
    + '<div contenteditable="true" role="textbox">PRIVATE PROMPT</div></main>');
  assert.equal(claude.observe(doc, 'https://claude.ai/chat/test').generating, true);
  const end = fixtureDocument('<main><div data-is-streaming="false">PRIVATE REPLY</div>'
    + '<div contenteditable="true" role="textbox"></div></main>');
  const controller = createController({ uuid: () => 'turn-1' });
  controller.sample(claude.observe(doc, 'https://claude.ai/chat/test'), 1000);
  controller.sample(claude.observe(end, 'https://claude.ai/chat/test'), 1100);
  assert.equal(controller.sample(claude.observe(end, 'https://claude.ai/chat/test'), 2000).outcome, 'unverified');
});

test('hidden controls, changed markup, and unsupported paths return unknown rather than a finish', () => {
  const hidden = fixtureDocument('<main hidden><button data-testid="stop-button">Stop</button></main>');
  const changed = fixtureDocument('<main><div data-new-provider-markup="message">PRIVATE REPLY</div></main>');
  assert.equal(chatgpt.observe(hidden, 'https://chatgpt.com/c/test').supported, false);
  assert.equal(chatgpt.observe(changed, 'https://chatgpt.com/c/test').supported, false);
  assert.equal(claude.observe(changed, 'https://claude.ai/project/test').supported, false);
});

test('synthetic scoped ChatGPT text conversations use the same controls; an empty scope requires its text composer', () => {
  const text = fixtureDocument('<main><div id="prompt-textarea" contenteditable="true"></div>'
    + '<button data-testid="stop-button"></button></main>');
  assert.equal(chatgpt.observe(text, 'https://chatgpt.com/g/g-p-project/c/conversation-1').generating, true);
  assert.equal(chatgpt.observe(text, 'https://chatgpt.com/g/g-custom').generating, true);
  const stopOnly = fixtureDocument('<main><button data-testid="stop-button"></button></main>');
  assert.equal(chatgpt.observe(stopOnly, 'https://chatgpt.com/g/g-custom').supported, false);
  assert.equal(chatgpt.observe(stopOnly, 'https://chatgpt.com/g/g-custom').generating, false);
  const otherLayout = fixtureDocument('<main><div contenteditable="true" role="textbox"></div></main>');
  assert.equal(chatgpt.observe(otherLayout, 'https://chatgpt.com/g/g-custom').supported, false);
});

test('content observer rotates its opaque identity between empty scopes, retains assignment, and reports health without page data', () => {
  const messages = [];
  const listeners = [];
  const root = {};
  let fixture = fixtureDocument('<main><div id="prompt-textarea" contenteditable="true">PRIVATE_PROMPT</div>'
    + '<button data-testid="stop-button"></button></main>');
  const location = { href: 'https://chatgpt.com/g/g-PRIVATE_SCOPE_A' };
  const document = {
    body: root, visibilityState: 'visible', addEventListener() {},
    querySelector: selector => selector === 'main' ? root : null,
    querySelectorAll: selector => fixture.querySelectorAll(selector),
  };
  const context = vm.createContext({
    crypto: crypto.webcrypto, URL, location, document, addEventListener() {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    MutationObserver: class { disconnect() {} observe() {} },
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: callback => listeners.push(callback) },
      sendMessage: message => { messages.push(structuredClone(message)); return Promise.resolve({ ok: true }); } } },
  });
  const base = path.join(__dirname, '../extensions/browser-bridge');
  for (const file of ['provider-utils.js', 'adapters/chatgpt.js', 'adapters/claude.js',
    'observation-controller.js', 'content-script.js']) {
    vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), context, { filename: file });
  }
  const dispatch = message => {
    let response;
    listeners[0](message, { id: 'test-extension' }, value => { response = structuredClone(value); });
    return response;
  };
  const a = messages.at(-1);
  assert.equal(a.status, 'running');
  assert.deepEqual(dispatch({ type: 'mori.health.check' }), { ok: true, v: 1, status: 'running' });
  location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B';
  // The focus check arrives before MutationObserver / the scheduled sample.
  // Both empty scopes have null conversation IDs, so compare the local route.
  assert.equal(dispatch({ type: 'mori.focus.check', pageInstanceId: a.pageInstanceId, conversationRef: null }).ok, false);
  dispatch({ type: 'mori.observe.now' });
  const b = messages.at(-1);
  assert.notEqual(b.pageInstanceId, a.pageInstanceId);
  assert.notEqual(b.generationToken, a.generationToken);
  assert.equal(dispatch({ type: 'mori.focus.check', pageInstanceId: a.pageInstanceId, conversationRef: null }).ok, false);
  location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B/c/opaque-conversation';
  dispatch({ type: 'mori.observe.now' });
  const assigned = messages.at(-1);
  assert.equal(assigned.pageInstanceId, b.pageInstanceId);
  assert.equal(assigned.generationToken, b.generationToken);
  assert.equal(dispatch({ type: 'mori.focus.check', pageInstanceId: b.pageInstanceId,
    conversationRef: '/c/opaque-conversation' }).ok, true);
  fixture = fixtureDocument('<main><div data-new-layout="true">PRIVATE_REPLY</div></main>');
  assert.deepEqual(dispatch({ type: 'mori.health.check' }), { ok: true, v: 1, status: 'unknown' });
  location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B/edit';
  assert.deepEqual(dispatch({ type: 'mori.health.check' }), { ok: true, v: 1, status: 'unsupported_route' });
  fixture = fixtureDocument('<main><div id="prompt-textarea" contenteditable="true"></div>'
    + '<button data-testid="stop-button"></button></main>');
  location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_C';
  dispatch({ type: 'mori.observe.now' });
  const c = messages.at(-1);
  assert.equal(c.status, 'running');
  fixture = fixtureDocument('<main><div id="prompt-textarea" contenteditable="true"></div>'
    + '<article data-message-author-role="assistant">PRIVATE_OLD_REPLY</article></main>');
  location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_D/c/old-conversation';
  dispatch({ type: 'mori.observe.now' });
  const oldConversation = messages.at(-1);
  assert.notEqual(oldConversation.pageInstanceId, c.pageInstanceId);
  assert.equal(oldConversation.generationToken, null);
  assert.equal(oldConversation.status, 'idle');
  assert.equal(oldConversation.outcome, null);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|https:|\/g\//);
});
