const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const transportApi = require('../extensions/browser-bridge/transport');
const { EXTENSION_ID, validateEvent } = require('../src/browser-bridge-protocol');

function event() { const listeners = []; return { listeners, addListener(listener) { listeners.push(listener); } }; }
async function workerFixture() {
  const log = [];
  const local = { moriClientId: 'profile-1', moriCredential: {
    clientId: 'profile-1', instanceId: 'instance-1', port: 23333, key: crypto.randomBytes(32).toString('base64url'),
  } };
  const session = {};
  const tabs = new Map([[7, { id: 7, windowId: 3, status: 'complete', url: 'https://chatgpt.com/c/test', pageId: 'page-1' }]]);
  let onWindowFocus = () => {};
  const transports = [];
  const clone = value => structuredClone(value);
  function area(data, name) {
    return {
      async setAccessLevel(value) { log.push({ type: 'access', area: name, value }); },
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])); },
      async set(value) { Object.assign(data, clone(value)); log.push({ type: 'save', area: name, keys: Object.keys(value) }); },
    };
  }
  class FakeTransport {
    constructor(options) { Object.assign(this, options); this.ready = false; this.enabled = true; this.canConnect = true; this.events = []; transports.push(this); }
    isReady() { return this.ready; }
    disconnect() { this.ready = false; this.onStatus({ state: 'disconnected', code: 'test_offline' }); }
    setEnabled(enabled) { this.enabled = enabled; if (enabled) void this.ensureConnected(); else this.disconnect(); }
    async ensureConnected() {
      if (this.ready || !this.enabled || !this.canConnect || !this.getCredential()) return;
      this.ready = true; this.onStatus({ state: 'connected', port: 23333 });
      void this.onReady();
    }
    async sendEvent(value) {
      if (!this.ready) throw new Error('disconnected');
      validateEvent(value);
      this.events.push(clone(value)); log.push({ type: 'send', value: clone(value) });
      return { type: 'event.ack', eventId: value.eventId, browserRunId: value.browserRunId,
        sessionId: value.sessionId, sequence: value.sequence, duplicate: false };
    }
  }
  const chrome = {
    storage: { local: area(local, 'local'), session: area(session, 'session') },
    runtime: { id: EXTENSION_ID, onMessage: event(), onStartup: event(), onInstalled: event(),
      getURL: file => `chrome-extension://${EXTENSION_ID}/${file}`,
      getManifest: () => ({ version: '0.1.0' }), openOptionsPage: async () => {} },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      async query() { return [...tabs.values()].map(clone); },
      async get(id) { if (!tabs.has(id)) throw new Error('no_tab'); return clone(tabs.get(id)); },
      async sendMessage(id, message) {
        const tab = tabs.get(id); if (!tab) throw new Error('no_tab');
        if (message.type === 'mori.observe.now') return { ok: true };
        const ref = new URL(tab.url).pathname;
        return { ok: tab.pageId === message.pageInstanceId && ref === message.conversationRef,
          pageInstanceId: tab.pageId, conversationRef: ref };
      },
      async update(id, value) { log.push({ type: 'tab-focus', id, value }); return clone(tabs.get(id)); },
    },
    windows: { async update(id, value) { log.push({ type: 'window-focus', id, value }); await onWindowFocus(); } },
    alarms: { async create() {}, onAlarm: event() },
    action: { onClicked: event() },
  };
  const root = path.join(__dirname, '../extensions/browser-bridge');
  const context = vm.createContext({ chrome, crypto: crypto.webcrypto, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, btoa, atob,
    importScripts(...files) {
      for (const file of files) {
        if (file === 'transport.js') context.MoriTransport = { ...transportApi, Transport: FakeTransport };
        else vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
      }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), context, { filename: 'service-worker.js' });
  await vm.runInContext('initialized', context);
  async function drain() {
    for (let i = 0; i < 5; i++) { await vm.runInContext('queue', context); await new Promise(resolve => setImmediate(resolve)); }
  }
  await drain();
  function dispatch(message, sender) {
    return new Promise(resolve => {
      const asynchronous = chrome.runtime.onMessage.listeners.some(listener => listener(message, sender, resolve) === true);
      if (!asynchronous) resolve({ unhandled: true });
    });
  }
  let contentSequence = 0;
  const sender = { id: EXTENSION_ID, frameId: 0, documentId: 'document-1', documentLifecycle: 'active',
    url: 'https://chatgpt.com/c/test', tab: { id: 7 } };
  async function observe(patch = {}, senderPatch = {}) {
    const result = await dispatch({ type: 'mori.observation', v: 1, pageInstanceId: 'page-1',
      contentSequence: ++contentSequence, observedAt: Date.now(), status: 'running', generationToken: 'generation-1', outcome: null,
      ...patch }, { ...sender, ...senderPatch });
    await drain(); return result;
  }
  return { chrome, log, local, session, tabs, context, drain, observe, dispatch, transport: transports[0],
    focusDuring: callback => { onWindowFocus = callback; } };
}

test('worker rejects forged sources and old documents; only metadata reaches storage and the wire', async () => {
  const f = await workerFixture();
  assert.equal((await f.observe({}, { frameId: 1 })).reason, 'invalid_sender');
  assert.equal((await f.observe({}, { url: 'https://unrelated.test/c/test' })).reason, 'invalid_sender');
  assert.equal((await f.observe({ pageInstanceId: 'old-page' })).reason, 'old_document');
  assert.equal((await f.dispatch({ type: 'mori.options.unpair' },
    { id: EXTENSION_ID, frameId: 0, url: 'https://chatgpt.com/c/test' })).unhandled, true);
  assert.equal((await f.observe({ prompt: 'PRIVATE_PROMPT', answer: 'PRIVATE_ANSWER', key: 'PRIVATE_KEY' })).ok, true);
  assert.equal(f.transport.events.filter(item => item.phase === 'running').length, 1);
  const records = JSON.stringify({ local: f.local, session: f.session, events: f.transport.events });
  assert.doesNotMatch(records, /PRIVATE_(?:PROMPT|ANSWER|KEY)/);
  assert.deepEqual(f.log.slice(0, 2).map(item => item.value.accessLevel), ['TRUSTED_CONTEXTS', 'TRUSTED_CONTEXTS']);
});

test('worker writes the offline terminal before sending, replays it before the next turn, and removes only its ACK', async () => {
  const f = await workerFixture();
  await f.observe();
  f.transport.canConnect = false; f.transport.disconnect();
  const before = f.log.length;
  await f.observe({ status: 'settled', outcome: 'unverified' });
  assert.equal(f.local.moriOutbox.events.length, 1);
  const receipt = f.local.moriOutbox.events[0];
  assert.equal(receipt.kind, 'terminal');
  await f.observe({ generationToken: 'generation-2' });
  const current = Object.values(f.session.moriSessions.sessions)[0];
  assert.equal(current.phase, 'running');
  assert.notEqual(current.turnId, receipt.turnId);
  assert.equal(f.local.moriOutbox.events[0].eventId, receipt.eventId);
  const saved = f.log.slice(before).filter(item => item.type === 'save');
  assert.equal(saved[0].keys.includes('moriOutbox'), true);
  assert.equal(saved[1].keys.includes('moriSessions'), true);
  const sentBefore = f.transport.events.length;
  f.transport.canConnect = true; await f.transport.ensureConnected(); await f.drain();
  const replay = f.transport.events.slice(sentBefore);
  assert.equal(replay[0].kind, 'terminal');
  assert.equal(replay[0].replay, true);
  assert.equal(replay[1].phase, 'running');
  assert.equal(replay[1].generation, 2);
  assert.equal(f.local.moriOutbox.events.length, 0);
  await f.observe({ generationToken: 'generation-2' });
  assert.equal(f.transport.events.at(-1).replay, false);
  assert.equal(f.transport.events.at(-1).observation, 'fresh');
});

test('worker revalidates after focusing; navigation during the window API cannot acknowledge a notice', async () => {
  const f = await workerFixture();
  await f.observe();
  const record = Object.values(f.session.moriSessions.sessions)[0];
  const request = { type: 'focus.request', v: 1, requestId: 'focus-1',
    browserRunId: f.session.moriSessions.browserRunId, sessionId: record.sessionId, tabId: 7,
    pageInstanceId: record.pageInstanceId, routeRevision: record.routeRevision,
    conversationRef: record.conversationRef, noticeSequence: null };
  assert.equal((await f.transport.onFocus(request)).ok, true);
  f.focusDuring(async () => { f.tabs.get(7).url = 'https://chatgpt.com/c/other'; });
  const changed = await f.transport.onFocus({ ...request, requestId: 'focus-2', noticeSequence: 1 });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'session_changed');
});
