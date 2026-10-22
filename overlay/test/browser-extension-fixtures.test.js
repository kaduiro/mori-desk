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
const providerUtils = require('../extensions/browser-bridge/provider-utils');

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
  const wrappers = new Map();
  const wrap = node => {
    if (wrappers.has(node)) return wrappers.get(node);
    const element = {
      hidden: Object.hasOwn(node.attribs, 'hidden'),
      getAttribute: name => node.attribs[name] ?? null,
      getClientRects: () => visible(node) ? [{}] : [],
      get textContent() { throw new Error('reply text must not be read'); },
      get innerHTML() { throw new Error('HTML must not be read'); },
    };
    wrappers.set(node, element);
    return element;
  };
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
  // A unique alternate editor is a candidate idle page; it cannot announce a
  // generation without the paired short stop + busy signals.
  assert.equal(chatgpt.observe(otherLayout, 'https://chatgpt.com/g/g-custom').supported, true);
  assert.equal(chatgpt.observe(otherLayout, 'https://chatgpt.com/g/g-custom').generating, false);
});

test('confirmed protocol boundary rotates empty scopes, retains proved assignment, and gates focus with the lease', async () => {
  const f = await contentLifecycleFixture('running', 'https://chatgpt.com/g/g-PRIVATE_SCOPE_A');
  const a = f.messages.at(-1);
  assert.equal(a.status, 'running');
  f.location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B';
  assert.equal(f.focus(a.pageInstanceId).ok, false);
  await f.health();
  assert.equal(f.messages.at(-1).status, 'unknown');
  f.replaceControls();
  await f.health();
  const b = f.messages.at(-1);
  assert.equal(b.status, 'running');
  assert.notEqual(b.pageInstanceId, a.pageInstanceId);
  assert.notEqual(b.generationToken, a.generationToken);
  f.location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B/c/opaque-conversation';
  await f.health();
  const assigned = f.messages.at(-1);
  assert.equal(assigned.pageInstanceId, b.pageInstanceId);
  assert.equal(assigned.generationToken, b.generationToken);
  assert.equal(f.focus(assigned.pageInstanceId).ok, true);
  f.location.href = 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B/edit';
  assert.equal((await f.health()).status, 'unsupported_route');
  assert.doesNotMatch(JSON.stringify(f.messages), /PRIVATE_|https:|\/g\//);
});

async function contentLifecycleFixture(initialLayout = 'unknown', initialUrl = 'https://chatgpt.com/c/test', { productionBinding = false } = {}) {
  const timeouts = new Map();
  const intervals = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const runtimeListeners = new Set();
  const messages = [];
  const registrations = [];
  let nextTimer = 0;
  let failure = null;
  let reply = { ok: true };
  let activeObserver = false;
  let observedTarget = null;
  let observedOptions = null;
  let mutationCallback;
  let layout = initialLayout;
  let metadataNodes = { links: [], users: [] };
  const root = {};
  const main = {};
  const draft = { value: '未送信 IME_DRAFT', selectionStart: 3, selectionEnd: 3, composing: true,
    focus() { throw new Error('observer must not focus the composer'); },
    dispatchEvent() { throw new Error('observer must not dispatch input/composition events'); } };
  const visible = () => ({ getAttribute: () => null, getClientRects: () => [{}] });
  let visibleElement = visible();
  const location = { href: initialUrl };
  const listen = (map, type, callback) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(callback);
  };
  const unlisten = (map, type, callback) => map.get(type)?.delete(callback);
  const document = {
    body: root, visibilityState: 'visible', activeElement: draft,
    querySelector: selector => selector === 'main' ? main : null,
    querySelectorAll: selector => {
      if (selector === 'a[href]') return metadataNodes.links;
      if (selector === '[data-message-author-role="user"]') return metadataNodes.users;
      if (['idle', 'running', 'settling'].includes(layout) && selector === '#prompt-textarea') return [visibleElement];
      if (layout === 'running' && selector === 'button[data-testid="stop-button"]') return [visibleElement];
      if (layout === 'settling' && selector === '[data-message-author-role="assistant"]') return [visibleElement];
      if (layout.startsWith('alternate-') && selector === '[contenteditable="true"]') return [visibleElement];
      if (layout.startsWith('alternate-') && selector === 'button[aria-label="Stop"]') return [visibleElement];
      if (layout === 'alternate-running' && selector === '[aria-busy="true"]') return [visibleElement];
      return [];
    },
    addEventListener: (type, callback) => listen(documentListeners, type, callback),
    removeEventListener: (type, callback) => unlisten(documentListeners, type, callback),
  };
  const runtime = {
    id: 'test-extension',
    onMessage: { addListener: callback => runtimeListeners.add(callback), removeListener: callback => runtimeListeners.delete(callback) },
    sendMessage(message) {
      if (message.type === 'mori.observer.register') {
        registrations.push(structuredClone(message));
        if (productionBinding) return Promise.resolve({ ok: false, reason: 'binding_unconfirmed' });
        return Promise.resolve({ ok: true, v: 1, pageInstanceId: message.pageInstanceId,
          workerEpoch: 'worker-fixture', leaseId: 'lease-fixture', bindingEpoch: 'binding-fixture' });
      }
      messages.push(structuredClone(message));
      if (failure?.kind === 'sync') throw new Error(failure.message);
      if (failure?.kind === 'async') return Promise.reject(new Error(failure.message));
      return Promise.resolve(typeof reply === 'function' ? reply(message) : reply);
    },
  };
  const context = vm.createContext({
    crypto: crypto.webcrypto, URL, location, document,
    addEventListener: (type, callback) => listen(windowListeners, type, callback),
    removeEventListener: (type, callback) => unlisten(windowListeners, type, callback),
    setTimeout: callback => { const id = ++nextTimer; timeouts.set(id, callback); return id; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: callback => { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      disconnect() { activeObserver = false; }
      observe(target, options) { activeObserver = true; observedTarget = target; observedOptions = options; }
    },
    chrome: { runtime },
  });
  const base = path.join(__dirname, '../extensions/browser-bridge');
  // Explicit post-binding protocol stand-in. These legacy regression cases
  // exercise admitted lifecycle behavior, not provider ownership detection.
  // Independent acceptance runs the real unconfirmed production binding.
  const reinject = async ({ start = true, attemptId = null } = {}) => {
    for (const file of ['provider-utils.js', 'adapters/chatgpt.js', 'adapters/claude.js',
      'observation-controller.js', 'conversation-metadata.js', 'conversation-binding.js', 'content-script.js']) {
      vm.runInContext(fs.readFileSync(path.join(base, file), 'utf8'), context, { filename: file });
    }
    if (!productionBinding) context.MoriConversationBinding = {
      createTracker: () => ({ sample: () => ({ state: 'confirmed', epoch: 'binding-fixture' }) }),
    };
    if (start) await context.MoriBrowserObserver.start({ attemptId });
  };
  await reinject();
  const rawHealth = () => new Promise(resolve => {
    for (const listener of runtimeListeners) {
      if (listener({ type: 'mori.health.check' }, { id: runtime.id },
        value => resolve(structuredClone(value))) === true) return;
    }
    resolve(null);
  });

  return {
    messages, registrations, timeouts, intervals, runtime, location, document, draft, reinject, rawHealth,
    get lifecycle() { return context.__moriBrowserObserverLifecycle; },
    orphanLegacyGuard() {
      context.__moriBrowserObserverLifecycle?.stop();
      delete context.__moriBrowserObserverLifecycle;
      context.__moriBrowserObserverInstalled = true;
    },
    ready() {
      let response;
      for (const listener of runtimeListeners) listener({ type: 'mori.observe.now' }, { id: runtime.id },
        value => { response = structuredClone(value); });
      return response;
    },
    focus(pageInstanceId) {
      let response;
      for (const listener of runtimeListeners) listener({ type: 'mori.focus.check', pageInstanceId,
        conversationRef: providerUtils.routeForUrl(location.href)?.conversationRef,
        workerEpoch: 'worker-fixture', leaseId: 'lease-fixture', bindingEpoch: 'binding-fixture' }, { id: runtime.id },
      value => { response = structuredClone(value); });
      return response;
    },
    fail: value => { failure = value; },
    reply: value => { reply = value; },
    async health() {
      // Synchronize the explicit protocol stand-in before asserting admitted
      // samples. rawHealth exercises quarantine without this test-driver step.
      await context.MoriBrowserObserver.start({ attemptId: null });
      return rawHealth();
    },
    showLayout: value => { layout = value; },
    replaceControls: () => { visibleElement = visible(); },
    clickConversation(href) {
      const link = { getAttribute: name => name === 'href' ? href : null };
      for (const listener of documentListeners.get('click') || []) listener({ isTrusted: true, button: 0,
        target: { closest: selector => selector === 'a[href]' ? link : null } });
    },
    popstate() { for (const listener of windowListeners.get('popstate') || []) listener(); },
    showMetadata(title, preview, href = '/c/test') {
      const node = (value, attributes = {}) => ({ nodeType: 1, tagName: 'DIV',
        childNodes: [{ nodeType: 3, nodeValue: value }],
        getAttribute: name => attributes[name] ?? null,
        getClientRects: () => [{}], closest: () => null });
      metadataNodes = { links: [node(title, { href, 'data-sidebar-item': 'true' })],
        users: [node(preview, { 'data-message-author-role': 'user' })] };
    },
    mutate: () => mutationCallback(),
    mutateOutsideMain(attributeName) {
      // Synthetic mutation delivery: a main-only observer cannot receive an
      // attribute change from its sibling composer. Body + the attribute
      // subscription are both necessary to deliver it before the heartbeat.
      if (activeObserver && observedTarget === root && observedOptions.subtree
        && observedOptions.attributes && observedOptions.attributeFilter.includes(attributeName)) mutationCallback();
    },
    get activeObserver() { return activeObserver; },
    get listenerCount() { return [...documentListeners.values(), ...windowListeners.values()]
      .reduce((total, callbacks) => total + callbacks.size, runtimeListeners.size); },
  };
}

test('a busy change beside main starts an alternate session through the mutation debounce, before the heartbeat', async () => {
  const f = await contentLifecycleFixture('alternate-stop-only');
  assert.equal(f.messages.at(-1).status, 'unknown');
  f.showLayout('alternate-running');
  f.mutateOutsideMain('aria-busy');
  assert.equal(f.timeouts.size, 1, 'the body sibling attribute change must schedule an observation');
  const [id, callback] = f.timeouts.entries().next().value;
  f.timeouts.delete(id); callback();
  assert.equal(f.messages.at(-1).status, 'running');
  assert.deepEqual(Object.keys(f.messages.at(-1)).sort(), ['type', 'v', 'pageInstanceId',
    'contentSequence', 'observedAt', 'status', 'generationToken', 'outcome',
    'conversationTitle', 'requestPreview', 'workerEpoch', 'leaseId', 'bindingEpoch'].sort());
  assert.equal(f.messages.at(-1).conversationTitle, '');
  assert.equal(f.messages.at(-1).requestPreview, '');
  assert.equal(f.intervals.size, 1, 'no heartbeat was needed to see the start');
});

test('an idle title/request update is published through the mutation debounce without inventing a generation', async () => {
  const f = await contentLifecycleFixture('idle');
  const before = f.messages.at(-1);
  f.showMetadata('会話の目標', '送信済みの依頼');
  f.mutate();
  const [id, callback] = f.timeouts.entries().next().value;
  f.timeouts.delete(id); callback();
  const after = f.messages.at(-1);
  assert.equal(after.conversationTitle, '会話の目標');
  assert.equal(after.requestPreview, '送信済みの依頼');
  assert.equal(after.status, 'idle');
  assert.equal(after.generationToken, null);
  assert.equal(after.outcome, null);
  assert.equal(after.pageInstanceId, before.pageInstanceId);
  assert.ok(after.contentSequence > before.contentSequence);
  assert.equal(f.intervals.size, 1);
});

test('SPA navigation quarantines lingering A generation controls so idle B never inherits a turn or terminal', async () => {
  const f = await contentLifecycleFixture('running');
  f.showMetadata('会話 A', 'A の依頼');
  await f.health();
  const a = f.messages.at(-1);
  assert.equal(a.status, 'running');
  f.location.href = 'https://chatgpt.com/c/b';
  await f.health();
  const transition = f.messages.at(-1);
  assert.equal(transition.status, 'unknown');
  assert.equal(transition.generationToken, null);
  assert.equal(transition.requestPreview, '');
  assert.notEqual(transition.pageInstanceId, a.pageInstanceId);
  // B's completed old conversation becomes visible, with no observed B turn.
  f.showLayout('settling');
  f.showMetadata('会話 B', 'B の過去の依頼', '/c/b');
  await f.health(); await f.health();
  const idle = f.messages.at(-1);
  assert.equal(idle.status, 'idle');
  assert.equal(idle.generationToken, null);
  assert.equal(idle.outcome, null);
  assert.equal(idle.conversationTitle, '会話 B');
  assert.equal(idle.requestPreview, 'B の過去の依頼');
  assert.ok(f.messages.every(message => message.pageInstanceId === a.pageInstanceId || message.status !== 'settled'));
  // A real subsequent B generation can be observed after controls change.
  f.replaceControls(); f.showLayout('running');
  await f.health();
  assert.equal(f.messages.at(-1).status, 'running');
  assert.ok(f.messages.at(-1).generationToken);
  assert.notEqual(f.messages.at(-1).generationToken, a.generationToken);
});

test('SPA navigation permits a real B generation when its controls are new, without inheriting A token', async () => {
  const f = await contentLifecycleFixture('running');
  const a = f.messages.at(-1);
  f.location.href = 'https://chatgpt.com/c/b';
  f.replaceControls();
  await f.health();
  const b = f.messages.at(-1);
  assert.equal(b.status, 'running');
  assert.notEqual(b.pageInstanceId, a.pageInstanceId);
  assert.notEqual(b.generationToken, a.generationToken);
});

for (const navigation of ['trusted-link', 'popstate', 'known-existing-link']) {
  test(`same-scope new-chat navigation via ${navigation} cannot be mistaken for a newly assigned conversation`, async () => {
    const f = await contentLifecycleFixture('idle', 'https://chatgpt.com/');
    if (navigation === 'known-existing-link') {
      f.showMetadata('既存の B', 'A の依頼', '/c/b');
      await f.health();
    }
    f.showLayout('running');
    await f.health();
    f.showMetadata('既存の B', 'A の依頼', '/c/b');
    await f.health();
    const a = f.messages.at(-1);
    if (navigation === 'trusted-link') f.clickConversation('/c/b');
    f.location.href = 'https://chatgpt.com/c/b';
    if (navigation === 'popstate') f.popstate();
    await f.health();
    const b = f.messages.at(-1);
    assert.equal(b.status, 'unknown');
    assert.equal(b.generationToken, null);
    assert.equal(b.requestPreview, '');
    assert.notEqual(b.pageInstanceId, a.pageInstanceId);
  });
}

test('new server-assigned conversation ID retains the running turn even if its new history link renders first', async () => {
  const f = await contentLifecycleFixture('idle', 'https://chatgpt.com/');
  f.showLayout('running');
  await f.health();
  const before = f.messages.at(-1);
  f.showMetadata('新しい会話', '新しい依頼', '/c/newly-assigned');
  await f.health();
  f.location.href = 'https://chatgpt.com/c/newly-assigned';
  await f.health();
  const assigned = f.messages.at(-1);
  assert.equal(assigned.pageInstanceId, before.pageInstanceId);
  assert.equal(assigned.generationToken, before.generationToken);
  assert.equal(assigned.status, 'running');
  assert.equal(assigned.requestPreview, '新しい依頼');
});

for (const kind of ['sync', 'async']) {
  test(`invalidated content runtime stops observation after a ${kind} API failure without uncaught errors or repeated sends`, async () => {
    const f = await contentLifecycleFixture('running');
    const poll = f.intervals.values().next().value;
    assert.equal(f.messages.length, 1);
    assert.equal(f.activeObserver, true);
    assert.ok(f.listenerCount > 0);
    f.showLayout('settling');
    poll();
    assert.equal(f.timeouts.size, 1); // completion verification is pending
    f.mutate();
    assert.equal(f.timeouts.size, 2); // mutation debounce is also pending
    f.fail({ kind, message: 'Extension context invalidated.' });
    assert.doesNotThrow(() => poll());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.activeObserver, false);
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.listenerCount, 0);
    const lastCount = f.messages.length;
    assert.doesNotThrow(() => poll());
    f.mutate();
    assert.equal(f.messages.length, lastCount);
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.messages.some(message => message.status === 'settled'), false);
  });
}

test('temporary content message failures preserve the observer and recover on the next poll', async () => {
  const f = await contentLifecycleFixture();
  const poll = f.intervals.values().next().value;
  for (const kind of ['sync', 'async']) {
    f.fail({ kind, message: 'Could not establish connection. Receiving end does not exist.' });
    assert.doesNotThrow(() => poll());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.activeObserver, true);
    assert.equal(f.intervals.size, 1);
    assert.ok(f.listenerCount > 0);
  }
  const beforeRecovery = f.messages.length;
  f.fail(null);
  assert.doesNotThrow(() => poll());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.messages.length, beforeRecovery + 1);
  assert.equal(f.activeObserver, true);
});

test('health preserves the running DOM state but reports a rejected document receipt and recovers without broadening identity', async () => {
  const f = await contentLifecycleFixture('running');
  f.reply({ ok: false, reason: 'old_document', private: 'PRIVATE_ACK_DATA' });
  const rejected = await f.rawHealth();
  assert.equal(rejected.status, 'running');
  assert.deepEqual(rejected.observationAck, { ok: false, reason: 'old_document' });
  assert.equal(f.activeObserver, true);
  assert.equal(f.intervals.size, 1);
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_|contentSequence|generationToken/);
  assert.equal(rejected.pageInstanceId, f.messages.at(-1).pageInstanceId);
  f.reply({ ok: true });
  assert.deepEqual((await f.health()).observationAck, { ok: true, reason: null });
  assert.equal(f.messages.every(message => message.status === 'running'), true);
});

test('health binds its receipt to its own observation even when the replies arrive out of order', async () => {
  const f = await contentLifecycleFixture('running');
  const receipts = [];
  f.reply(() => new Promise(resolve => receipts.push(resolve)));
  const first = f.rawHealth();
  const second = f.rawHealth();
  assert.equal(receipts.length, 2);
  receipts[1]({ ok: true });
  assert.deepEqual((await second).observationAck, { ok: true, reason: null });
  receipts[0]({ ok: false, reason: 'old_document' });
  assert.deepEqual((await first).observationAck, { ok: false, reason: 'old_document' });
});

test('health distinguishes missing worker receipts from acceptance and never exposes exception text', async () => {
  const f = await contentLifecycleFixture('running');
  f.reply(undefined);
  assert.deepEqual((await f.health()).observationAck, { ok: null, reason: 'ack_unavailable' });
  f.reply({ ok: false, reason: 'PRIVATE_SERVER_ERROR https://chatgpt.com/c/private' });
  const rejected = await f.health();
  assert.deepEqual(rejected.observationAck, { ok: false, reason: 'observation_failed' });
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_|https:|private/);
  for (const kind of ['sync', 'async']) {
    f.fail({ kind, message: 'PRIVATE_API_FAILURE https://chatgpt.com/c/private' });
    const unavailable = await f.health();
    assert.deepEqual(unavailable.observationAck, { ok: null, reason: 'worker_unavailable' });
    assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_|https:|private/);
    assert.equal(f.activeObserver, true);
  }
  f.fail(null); f.reply({ ok: true });
  assert.deepEqual((await f.health()).observationAck, { ok: true, reason: null });
});

test('a missing extension runtime ID stops the observer before another API call', async () => {
  const f = await contentLifecycleFixture();
  const poll = f.intervals.values().next().value;
  const before = f.messages.length;
  delete f.runtime.id;
  assert.doesNotThrow(() => poll());
  assert.equal(f.messages.length, before);
  assert.equal(f.activeObserver, false);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.listenerCount, 0);
});

test('reinjection preserves a healthy observer, its running identity, timers, and unfinished input', async () => {
  const f = await contentLifecycleFixture('running');
  const original = f.messages.at(-1);
  const owner = f.lifecycle;
  const listeners = f.listenerCount;
  const input = { value: f.draft.value, selectionStart: f.draft.selectionStart,
    selectionEnd: f.draft.selectionEnd, composing: f.draft.composing };
  await f.reinject({ start: false }); await f.reinject({ start: false });
  assert.equal(f.lifecycle, owner);
  assert.equal(f.messages.length, 1);
  assert.equal(f.listenerCount, listeners);
  assert.equal(f.intervals.size, 1);
  const ready = f.ready();
  assert.equal(ready.observerVersion, '0.1.8');
  assert.equal(ready.pageInstanceId, original.pageInstanceId);
  assert.equal(f.messages.at(-1).generationToken, original.generationToken);
  assert.equal(f.document.activeElement, f.draft);
  assert.deepEqual({ value: f.draft.value, selectionStart: f.draft.selectionStart,
    selectionEnd: f.draft.selectionEnd, composing: f.draft.composing }, input);
  assert.doesNotMatch(JSON.stringify(f.messages), /IME_DRAFT/);
});

test('a stopped observer or orphaned 0.1.5 boolean guard can recover without reload or a fabricated completion', async () => {
  for (const legacy of [false, true]) {
    const f = await contentLifecycleFixture('running');
    const original = f.messages.at(-1);
    const oldOwner = f.lifecycle;
    if (legacy) f.orphanLegacyGuard();
    else oldOwner.stop();
    assert.equal(f.listenerCount, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.ready(), undefined);
    // The old turn has ended while its observer was unavailable. A recovered
    // observer can report this idle baseline; it cannot attest to that end.
    f.showLayout('settling'); await f.reinject();
    const restored = f.messages.at(-1);
    assert.notEqual(restored.pageInstanceId, original.pageInstanceId);
    assert.equal(restored.status, 'idle');
    assert.equal(restored.generationToken, null);
    assert.equal(restored.outcome, null);
    assert.equal(f.focus(original.pageInstanceId).ok, false);
    assert.equal(f.focus(restored.pageInstanceId).ok, true);
    assert.equal(f.intervals.size, 1);
    assert.equal(f.lifecycle.isActive(), true);
    oldOwner.stop();
    assert.equal(f.lifecycle.isActive(), true, 'late cleanup cannot erase a replacement lifecycle');
    assert.equal((await f.health()).pageInstanceId, restored.pageInstanceId);
    assert.ok(f.messages.every(message => message.status !== 'settled'));
    assert.equal(f.draft.value, '未送信 IME_DRAFT');
    assert.equal(f.draft.composing, true);
    assert.equal(f.document.activeElement, f.draft);
  }
});

test('a health reply retains the sampled page identity when a same-document route changes before its receipt', async () => {
  const f = await contentLifecycleFixture('idle');
  const receipts = [];
  f.reply(() => new Promise(resolve => receipts.push(resolve)));
  const old = f.messages.at(-1).pageInstanceId;
  const delayedHealth = f.rawHealth();
  f.location.href = 'https://chatgpt.com/c/other';
  const current = f.ready();
  assert.notEqual(current.pageInstanceId, old);
  receipts[0]({ ok: true });
  const response = await delayedHealth;
  assert.equal(response.pageInstanceId, old);
  assert.equal(response.route.conversationRef, '/c/test');
  assert.equal(f.focus(response.pageInstanceId).ok, false);
  await new Promise(resolve => setImmediate(resolve));
  receipts[1]?.({ ok: true });
});

test('production binding stays quarantined across install, health, timer, mutation and route changes', async () => {
  const f = await contentLifecycleFixture('running', 'https://chatgpt.com/c/a', { productionBinding: true });
  assert.equal(f.messages.length, 0);
  assert.equal(f.registrations.length, 1);
  const first = f.ready();
  assert.equal(first.binding.state, 'unconfirmed');
  assert.equal(first.lease, null);
  assert.equal(f.focus(first.pageInstanceId).ok, false);
  for (const state of ['running', 'settling', 'idle']) {
    f.showLayout(state); f.location.href = 'https://chatgpt.com/c/b';
    f.showMetadata('会話 A', 'PRIVATE_OLD_A', '/c/a');
    f.replaceControls(); f.mutate();
    for (const [id, callback] of [...f.timeouts]) { f.timeouts.delete(id); callback(); }
    for (const callback of f.intervals.values()) callback();
    const health = await f.rawHealth();
    assert.equal(health.status, 'unknown');
    assert.deepEqual(health.observationAck, { ok: false, reason: 'binding_unconfirmed' });
    assert.equal(f.focus(health.pageInstanceId).ok, false);
  }
  assert.equal(f.messages.length, 0, 'no metadata or generation payload crosses before binding');
  assert.doesNotMatch(JSON.stringify(f.registrations), /PRIVATE_|https:|会話/);
});

test('delayed packaged-file loading alone cannot install an unticketed observer', async () => {
  const f = await contentLifecycleFixture('running');
  f.lifecycle.stop();
  const count = f.messages.length, registrations = f.registrations.length;
  await f.reinject({ start: false });
  assert.equal(f.lifecycle, undefined);
  assert.equal(f.activeObserver, false);
  assert.equal(f.messages.length, count);
  assert.equal(f.registrations.length, registrations);
  assert.equal(f.listenerCount, 0);
});

test('lease loss breaks generation continuity while worker-only renewal preserves continuously sampled work', async () => {
  const paused = await contentLifecycleFixture('running');
  const prior = paused.messages.at(-1);
  paused.reply({ ok: false, reason: 'paused' });
  await paused.rawHealth();
  paused.showLayout('settling'); paused.reply({ ok: true });
  await paused.health();
  assert.notEqual(paused.messages.at(-1).pageInstanceId, prior.pageInstanceId);
  assert.equal(paused.messages.at(-1).status, 'idle');
  const continuous = await contentLifecycleFixture('running');
  const running = continuous.messages.at(-1);
  await continuous.reinject({ attemptId: 'replacement-worker-attempt' });
  assert.equal(continuous.messages.at(-1).pageInstanceId, running.pageInstanceId);
  assert.equal(continuous.messages.at(-1).generationToken, running.generationToken);
  continuous.showLayout('settling');
  await continuous.rawHealth();
  await new Promise(resolve => setTimeout(resolve, 850));
  await paused.rawHealth(); await continuous.rawHealth();
  assert.equal(paused.messages.some(message => message.status === 'settled'), false,
    'resuming with a new lease must not fill an unsampled gap');
  const terminals = continuous.messages.filter(message => message.status === 'settled');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].generationToken, running.generationToken);
});
