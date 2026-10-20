const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const transportApi = require('../extensions/browser-bridge/transport');
const providerUtils = require('../extensions/browser-bridge/provider-utils');
const { EXTENSION_ID, validateEvent } = require('../src/browser-bridge-protocol');

function event() { const listeners = []; return { listeners, addListener(listener) { listeners.push(listener); } }; }
async function workerFixture({ savedLocal = null, savedSession = null, savedTabs = null } = {}) {
  const log = [];
  const local = savedLocal ? structuredClone(savedLocal) : { moriClientId: 'profile-1', moriCredential: {
    clientId: 'profile-1', instanceId: 'instance-1', port: 23333, key: crypto.randomBytes(32).toString('base64url'),
  } };
  const session = structuredClone(savedSession || {});
  const tabs = new Map(savedTabs ? structuredClone(savedTabs) :
    [[7, { id: 7, windowId: 3, status: 'complete', url: 'https://chatgpt.com/c/test', pageId: 'page-1' }]]);
  let onWindowFocus = () => {};
  let onHealth = () => {};
  let onDocumentCheck = () => {};
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
    async ensureConnected(options) {
      log.push({ type: 'ensure-connect', immediate: options?.immediate === true });
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
        if (message.type === 'mori.health.check') {
          log.push({ type: 'health-probe', id });
          if (tab.noReceiver) throw new Error('no_receiver_PRIVATE_URL');
          await onHealth(tab);
          return tab.invalidHealth ? {} : { ok: true, v: 1, status: tab.healthState || 'idle', observationAck: tab.healthAck };
        }
        const ref = providerUtils.routeForUrl(tab.url)?.conversationRef ?? null;
        const result = { ok: tab.pageId === message.pageInstanceId && ref === message.conversationRef,
          pageInstanceId: tab.pageId, conversationRef: ref };
        await onDocumentCheck(tab, message);
        return result;
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
    focusDuring: callback => { onWindowFocus = callback; }, healthDuring: callback => { onHealth = callback; },
    documentCheckDuring: callback => { onDocumentCheck = callback; } };
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

test('worker does not acknowledge stale or duplicate observations as newly accepted', async () => {
  const f = await workerFixture();
  assert.equal((await f.observe({ observedAt: Date.now() - 31000 })).reason, 'old_observation');
  assert.equal(f.transport.events.length, 0);
  assert.equal((await f.observe({ conversationTitle: '現在の会話', requestPreview: '現在の依頼' })).ok, true);
  const before = f.transport.events.length;
  const previous = structuredClone(f.session.moriSessions);
  const duplicate = await f.observe({ contentSequence: 2,
    conversationTitle: '重複した古い会話', requestPreview: '古い依頼' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'duplicate_observation');
  assert.equal(f.transport.events.length, before);
  assert.deepEqual(f.session.moriSessions, previous);
});

test('worker binds authorized idle metadata to the current route and rejects the old focus target after navigation', async () => {
  const f = await workerFixture();
  assert.equal((await f.observe({ status: 'idle', generationToken: null,
    conversationTitle: '会話 A', requestPreview: 'A の送信済み依頼' })).ok, true);
  const a = f.transport.events.at(-1);
  assert.equal(a.phase, 'idle');
  assert.equal(a.kind, 'observation');
  assert.equal(a.turnId, null);
  assert.equal(a.generation, 0);
  assert.equal(a.conversationTitle, '会話 A');
  const focus = event => ({ type: 'focus.request', v: 1, requestId: 'focus-idle',
    browserRunId: event.browserRunId, sessionId: event.sessionId, tabId: event.tabId,
    pageInstanceId: event.pageInstanceId, routeRevision: event.routeRevision,
    conversationRef: event.conversationRef, noticeSequence: null });
  assert.equal((await f.transport.onFocus(focus(a))).ok, true);
  f.tabs.get(7).url = 'https://chatgpt.com/c/conversation-b';
  f.tabs.get(7).pageId = 'page-b';
  assert.equal((await f.observe({ conversationTitle: 'STALE_A', requestPreview: 'STALE_REQUEST' })).reason, 'old_document');
  assert.equal((await f.observe({ status: 'idle', generationToken: null, pageInstanceId: 'page-b',
    conversationTitle: '会話 B', requestPreview: '' }, { url: 'https://chatgpt.com/c/conversation-b' })).ok, true);
  const b = f.transport.events.at(-1);
  assert.equal(b.conversationRef, '/c/conversation-b');
  assert.equal(b.conversationTitle, '会話 B');
  assert.equal(b.requestPreview, '');
  assert.notEqual(b.sessionId, a.sessionId);
  assert.equal((await f.transport.onFocus(focus(a))).ok, false);
  assert.equal((await f.transport.onFocus(focus(b))).ok, true);
  assert.ok(f.transport.events.every(event => event.kind !== 'terminal'));
  assert.doesNotMatch(JSON.stringify({ session: f.session, events: f.transport.events }), /STALE_/);
});

test('navigation during the current-document reply cannot commit stale title or preview', async () => {
  const f = await workerFixture();
  f.documentCheckDuring(async tab => { tab.url = 'https://chatgpt.com/c/new-route'; });
  const result = await f.observe({ conversationTitle: 'STALE_TITLE', requestPreview: 'STALE_PREVIEW' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'old_document');
  assert.equal(f.transport.events.length, 0);
  assert.deepEqual(Object.keys(f.session.moriSessions.sessions), []);
});

test('worker restart and page reload reuse the idle tab session within the same browser run', async () => {
  const first = await workerFixture();
  await first.observe({ status: 'idle', generationToken: null, conversationTitle: '継続する会話', requestPreview: '送信済みの依頼' });
  const original = first.transport.events.at(-1);
  const restarted = await workerFixture({ savedLocal: first.local, savedSession: first.session,
    savedTabs: [...first.tabs] });
  const replay = restarted.transport.events.at(-1);
  assert.equal(replay.browserRunId, original.browserRunId);
  assert.equal(replay.sessionId, original.sessionId);
  assert.equal(replay.replay, true);
  restarted.tabs.get(7).pageId = 'page-reloaded';
  assert.equal((await restarted.observe({ status: 'idle', generationToken: null, contentSequence: 1,
    pageInstanceId: 'page-reloaded', conversationTitle: '継続する会話', requestPreview: '' },
  { documentId: 'document-reloaded' })).ok, true);
  const current = restarted.transport.events.at(-1);
  assert.equal(current.browserRunId, original.browserRunId);
  assert.equal(current.sessionId, original.sessionId);
  assert.equal(current.requestPreview, '');
  assert.ok(current.routeRevision > original.routeRevision);
  assert.equal(Object.keys(restarted.session.moriSessions.tabs).length, 1);
  assert.ok(restarted.transport.events.every(event => event.kind !== 'terminal'));
});

test('worker returns a capacity refusal for the new tab instead of claiming its observation was accepted', async () => {
  const f = await workerFixture();
  f.tabs.clear();
  for (let id = 1; id <= 21; id++) {
    const url = `https://chatgpt.com/c/test-${id}`;
    f.tabs.set(id, { id, windowId: 3, status: 'complete', url, pageId: `page-${id}` });
    const result = await f.observe({ pageInstanceId: `page-${id}` },
      { url, tab: { id }, documentId: `document-${id}` });
    if (id <= 20) assert.equal(result.ok, true);
    else {
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'capacity');
    }
  }
  assert.equal(Object.keys(f.session.moriSessions.tabs).length, 20);
  assert.equal(f.transport.events.length, 20);
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
  f.transport.canConnect = true;
  const retried = await f.dispatch({ type: 'mori.options.retry' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.equal(retried.ok, true);
  assert.equal(f.log.filter(item => item.type === 'ensure-connect').at(-1).immediate, true);
  await f.drain();
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

test('observations and reconnect alarms do not request an immediate retry; page scripts cannot force it', async () => {
  const f = await workerFixture();
  f.transport.canConnect = false; f.transport.disconnect();
  const before = f.log.filter(item => item.type === 'ensure-connect').length;
  assert.equal((await f.observe()).ok, true);
  for (const listener of f.chrome.alarms.onAlarm.listeners) listener({ name: 'mori-reconnect' });
  await f.drain();
  const automatic = f.log.filter(item => item.type === 'ensure-connect').slice(before);
  assert.equal(automatic.length, 2);
  assert.equal(automatic.every(item => item.immediate === false), true);
  assert.equal((await f.dispatch({ type: 'mori.options.retry' },
    { id: EXTENSION_ID, frameId: 0, url: 'https://chatgpt.com/c/test' })).unhandled, true);
  assert.equal(f.log.filter(item => item.type === 'ensure-connect').length, before + 2);
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

test('worker accepts a scoped ChatGPT conversation and focuses its canonical ID without storing its name', async () => {
  const f = await workerFixture();
  const url = 'https://chatgpt.com/g/g-p-PRIVATE_PROJECT_NAME/c/test?private=PRIVATE_QUERY';
  f.tabs.get(7).url = url;
  assert.equal((await f.observe({}, { url })).ok, true);
  assert.equal(f.transport.events.at(-1).conversationRef, '/c/test');
  assert.doesNotMatch(JSON.stringify({ local: f.local, session: f.session, events: f.transport.events }), /PRIVATE_|\/g\//);
  const record = Object.values(f.session.moriSessions.sessions)[0];
  const request = { type: 'focus.request', v: 1, requestId: 'focus-nested',
    browserRunId: f.session.moriSessions.browserRunId, sessionId: record.sessionId, tabId: 7,
    pageInstanceId: record.pageInstanceId, routeRevision: record.routeRevision,
    conversationRef: record.conversationRef, noticeSequence: null };
  assert.equal((await f.transport.onFocus(request)).ok, true);
  f.focusDuring(async () => { f.tabs.get(7).url = 'https://chatgpt.com/g/g-p-PRIVATE_OTHER/c/other'; });
  assert.equal((await f.transport.onFocus({ ...request, requestId: 'focus-nested-race' })).ok, false);
});

test('options health reports metadata-only counts for reload, route, unknown, idle, running, and settled pages', async () => {
  const f = await workerFixture();
  f.tabs.clear();
  const makeTab = (id, patch = {}) => ({ id, windowId: 3, status: 'complete',
    url: `https://chatgpt.com/c/private-${id}`,
    title: 'PRIVATE_TITLE', ...patch });
  const entries = [
    makeTab(10, { noReceiver: true }),
    makeTab(11, { url: 'https://chatgpt.com/g/g-PRIVATE_GPT/edit' }),
    makeTab(12, { healthState: 'unknown' }),
    makeTab(13, { healthState: 'idle' }),
    makeTab(14, { healthState: 'running', url: 'https://chatgpt.com/g/g-p-PRIVATE_PROJECT/c/private-14' }),
    makeTab(15, { healthState: 'settled' }),
    makeTab(16, { url: 'https://unrelated.test/c/PRIVATE_OTHER_ORIGIN' }),
  ];
  for (const tab of entries) f.tabs.set(tab.id, tab);
  const beforeStorage = JSON.stringify({ local: f.local, session: f.session });
  const summary = await f.dispatch({ type: 'mori.options.health' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.equal(summary.ok, true);
  assert.equal(summary.totalTabs, 6);
  assert.equal(summary.checkedTabs, 6);
  assert.deepEqual({ ...summary.counts }, { needsReload: 1, unsupportedRoute: 1, unknown: 1, idle: 1, running: 1, settled: 1 });
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|private-|https:|tabId|pageInstanceId|conversationRef/);
  assert.equal(JSON.stringify({ local: f.local, session: f.session }), beforeStorage);
  assert.deepEqual(f.log.filter(item => item.type === 'health-probe').map(item => item.id), [10, 12, 13, 14, 15]);
  assert.equal(f.transport.events.length, 0);
  assert.deepEqual(structuredClone(summary.observationDelivery), { accepted: 0, rejected: 0, unconfirmed: 4,
    runningAccepted: 0, reasons: { ack_unavailable: 4 } });
  assert.equal((await f.dispatch({ type: 'mori.options.health' },
    { id: EXTENSION_ID, frameId: 0, url: 'https://chatgpt.com/c/test' })).unhandled, true);
});

test('health cannot report accepted generation when the worker rejects the current document; a valid observation recovers', async () => {
  const f = await workerFixture();
  const tab = f.tabs.get(7);
  tab.healthState = 'running';
  let pageInstanceId = 'old-page';
  f.healthDuring(async current => { current.healthAck = await f.observe({ pageInstanceId }); });
  const sender = { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') };
  const refused = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.equal(refused.counts.running, 1);
  assert.deepEqual(structuredClone(refused.observationDelivery), { accepted: 0, rejected: 1, unconfirmed: 0,
    runningAccepted: 0, reasons: { old_document: 1 } });
  assert.equal(f.transport.events.length, 0);
  assert.doesNotMatch(JSON.stringify(refused), /old-page|pageInstanceId|documentId|https:|conversationRef/);
  pageInstanceId = 'page-1';
  const accepted = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.equal(accepted.counts.running, 1);
  assert.deepEqual(structuredClone(accepted.observationDelivery), { accepted: 1, rejected: 0, unconfirmed: 0,
    runningAccepted: 1, reasons: {} });
  assert.equal(f.transport.events.at(-1).observation, 'fresh');
});

test('health projects only fixed receipt codes and treats an older observer with no receipt as unconfirmed', async () => {
  const f = await workerFixture();
  const tab = f.tabs.get(7);
  tab.healthState = 'running';
  tab.healthAck = { ok: false, reason: 'PRIVATE_API_MESSAGE https://chatgpt.com/c/private', title: 'PRIVATE_TITLE' };
  const sender = { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') };
  const rejected = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.deepEqual(structuredClone(rejected.observationDelivery), { accepted: 0, rejected: 1, unconfirmed: 0,
    runningAccepted: 0, reasons: { observation_failed: 1 } });
  assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_|https:|private|title/);
  delete tab.healthAck;
  const oldObserver = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.deepEqual(structuredClone(oldObserver.observationDelivery), { accepted: 0, rejected: 0, unconfirmed: 1,
    runningAccepted: 0, reasons: { ack_unavailable: 1 } });
});

test('options health bounds probes at 20 and treats navigation or an old observer as unverified', async () => {
  const f = await workerFixture();
  f.tabs.clear();
  for (let id = 0; id < 25; id++) f.tabs.set(id, { id, windowId: 1, status: 'complete',
    url: `https://chatgpt.com/c/conversation-${id}`, invalidHealth: id === 1 });
  f.healthDuring(tab => { if (tab.id === 0) tab.url = 'https://chatgpt.com/c/changed-during-probe'; });
  const summary = await f.dispatch({ type: 'mori.options.health' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.equal(summary.totalTabs, 25);
  assert.equal(summary.checkedTabs, 20);
  assert.equal(summary.remainingTabs, 5);
  assert.equal(f.log.filter(item => item.type === 'health-probe').length, 20);
  assert.deepEqual({ ...summary.counts }, { needsReload: 1, unsupportedRoute: 0, unknown: 1, idle: 18, running: 0, settled: 0 });
});

test('options health remains available when monitoring is paused or this Chrome profile is unpaired', async () => {
  const f = await workerFixture();
  const sender = { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') };
  assert.equal((await f.dispatch({ type: 'mori.options.enabled', enabled: false }, sender)).ok, true);
  const paused = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.equal(paused.ok, true);
  assert.equal(paused.enabled, false);
  assert.equal(paused.paired, true);
  assert.equal((await f.dispatch({ type: 'mori.options.unpair' }, sender)).ok, true);
  const unpaired = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.equal(unpaired.ok, true);
  assert.equal(unpaired.paired, false);
  assert.equal(unpaired.connectionState, 'unpaired');
});
