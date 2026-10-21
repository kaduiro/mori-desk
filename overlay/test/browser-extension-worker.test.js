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
async function workerFixture({ savedLocal = null, savedSession = null, savedTabs = null,
  configureChrome = () => {}, timers = null } = {}) {
  const log = [];
  const local = savedLocal ? structuredClone(savedLocal) : { moriClientId: 'profile-1', moriCredential: {
    clientId: 'profile-1', instanceId: 'instance-1', port: 23333, key: crypto.randomBytes(32).toString('base64url'),
  } };
  const session = structuredClone(savedSession || {});
  const tabs = new Map(savedTabs ? structuredClone(savedTabs) :
    [[7, { id: 7, windowId: 3, status: 'complete', url: 'https://chatgpt.com/c/test',
      documentId: 'document-1', pageId: 'page-1' }]]);
  let onWindowFocus = () => {};
  let onHealth = () => {};
  let onDocumentCheck = () => {};
  let onScript = () => {};
  let onProbe = () => {};
  let injectionCount = 0;
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
      getManifest: () => ({ version: '0.1.7' }), openOptionsPage: async () => {} },
    tabs: {
      onRemoved: event(), onUpdated: event(),
      async query() { return [...tabs.values()].map(clone); },
      async get(id) { if (!tabs.has(id)) throw new Error('no_tab'); return clone(tabs.get(id)); },
      async sendMessage(id, message, options) {
        const tab = tabs.get(id); if (!tab) throw new Error('no_tab');
        if (tab.noReceiver || (options?.documentId && options.documentId !== (tab.documentId || `document-${id}`))) {
          throw new Error('no_receiver_PRIVATE_URL');
        }
        // This is a protocol-boundary stand-in, not provider DOM evidence.
        // Tests explicitly exercise confirmed and unconfirmed binding states.
        const identity = { observerVersion: tab.observerVersion || '0.1.7',
          pageInstanceId: tab.pageId || `page-${id}`, route: providerUtils.routeForUrl(tab.url),
          binding: { state: tab.bindingState || 'confirmed', epoch: tab.bindingEpoch || `binding-${id}` },
          lease: tab.bindingState === 'unconfirmed' ? null : tab.lease || null };
        if (message.type === 'mori.observer.identity') {
          log.push({ type: 'observer-probe', id, options: clone(options) });
          if (message.pageInstanceId) await onDocumentCheck(tab, message);
          else await onProbe(tab);
          return tab.invalidReady ? {} : tab.modernObserver === false ? { ok: true } : { ok: true, v: 1, ...identity };
        }
        if (message.type === 'mori.observe.now') {
          log.push({ type: 'observer-refresh', id });
          return { ok: true, v: 1, ...identity };
        }
        if (message.type === 'mori.health.check') {
          log.push({ type: 'health-probe', id });
          await onHealth(tab);
          return tab.invalidHealth ? {} : { ok: true, v: 1, status: tab.healthState || 'idle',
            observationAck: tab.healthAck, ...identity };
        }
        const ref = providerUtils.routeForUrl(tab.url)?.conversationRef ?? null;
        const result = { ok: tab.pageId === message.pageInstanceId && ref === message.conversationRef
            && identity.binding.state === 'confirmed' && !!tab.lease
            && ['workerEpoch', 'leaseId', 'bindingEpoch'].every(field => tab.lease[field] === message[field]),
          pageInstanceId: tab.pageId, conversationRef: ref };
        await onDocumentCheck(tab, message);
        return result;
      },
      async update(id, value) { log.push({ type: 'tab-focus', id, value }); return clone(tabs.get(id)); },
    },
    scripting: { async executeScript(options) {
      const tab = tabs.get(options.target.tabId);
      log.push({ type: options.files ? 'observer-inject' : options.args ? 'observer-start' : 'document-probe', target: clone(options.target),
        world: options.world, files: options.files && [...options.files] });
      if (!tab || tab.injectionError) throw new Error('PRIVATE_INJECTION_ERROR https://chatgpt.com/c/private');
      const documentId = tab.documentId || `document-${tab.id}`;
      if (options.files || options.args) {
        if (options.target.documentIds?.[0] !== documentId) throw new Error('no_document_PRIVATE_URL');
      }
      if (options.files) tab.installed = true;
      if (options.args && !tab.injectionNoop) {
        if (tab.noReceiver || tab.modernObserver === false || (tab.observerVersion && tab.observerVersion !== '0.1.7')) {
          tab.noReceiver = false; tab.invalidReady = false; tab.modernObserver = true;
          tab.pageId = `recovered-page-${++injectionCount}`;
          tab.observerVersion = '0.1.7'; tab.lease = null;
        }
        tab.pageId ||= `page-${tab.id}`;
        tab.documentId ||= documentId;
        const registered = await registerTab(tab, options.args[0]);
        await onScript(options, tab);
        return [{ frameId: 0, documentId, result: registered }];
      }
      const url = new URL(tab.url);
      const result = { frameId: 0, documentId,
        result: { url: url.origin + url.pathname, readyState: 'complete', active: !tab.prerendering } };
      await onScript(options, tab);
      return [result];
    } },
    permissions: { async contains({ origins }) { log.push({ type: 'permission-check', origins }); return true; } },
    windows: { async update(id, value) { log.push({ type: 'window-focus', id, value }); await onWindowFocus(); } },
    alarms: { async create() {}, onAlarm: event() },
    action: { onClicked: event() },
  };
  configureChrome(chrome);
  const root = path.join(__dirname, '../extensions/browser-bridge');
  const context = vm.createContext({ chrome, crypto: crypto.webcrypto, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, btoa, atob,
    ...(timers || {}),
    importScripts(...files) {
      for (const file of files) {
        if (file === 'transport.js') context.MoriTransport = { ...transportApi, Transport: FakeTransport };
        else vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
      }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8'), context, { filename: 'service-worker.js' });
  // Model a manifest-started observer registering through the actual worker
  // listener. Do not seed grants or worker maps in the test context.
  const initialRegistrations = [...tabs.values()].filter(tab => !tab.noReceiver && tab.pageId
    && tab.modernObserver !== false && (!tab.observerVersion || tab.observerVersion === '0.1.7')
    && providerUtils.routeForUrl(tab.url)).map(tab => registerTab(tab));
  await vm.runInContext('initialized', context);
  await Promise.all(initialRegistrations);
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
  async function registerTab(tab, attemptId = null, patch = {}, senderPatch = {}) {
    const registered = await dispatch({ type: 'mori.observer.register', v: 1,
      pageInstanceId: tab.pageId || `page-${tab.id}`, observerVersion: '0.1.7', attemptId, ...patch },
    { id: EXTENSION_ID, frameId: 0, documentId: tab.documentId || `document-${tab.id}`,
      documentLifecycle: 'active', url: tab.url, tab: { id: tab.id }, ...senderPatch });
    if (registered.ok) {
      tab.lease = providerUtils.safeLease(registered);
      tab.grantedPageId = registered.pageInstanceId;
      tab.grantedDocumentId = tab.documentId || `document-${tab.id}`;
    }
    return registered;
  }
  let contentSequence = 0;
  const sender = { id: EXTENSION_ID, frameId: 0, documentId: 'document-1', documentLifecycle: 'active',
    url: 'https://chatgpt.com/c/test', tab: { id: 7 } };
  async function observe(patch = {}, senderPatch = {}) {
    const currentSender = { ...sender, ...senderPatch };
    const currentTab = tabs.get(currentSender.tab.id);
    const pageId = patch.pageInstanceId || 'page-1';
    if (currentTab && pageId === (currentTab.pageId || `page-${currentTab.id}`)
      && providerUtils.sameRoute(providerUtils.routeForUrl(currentSender.url), providerUtils.routeForUrl(currentTab.url))
      && (!currentTab.lease || currentTab.grantedPageId !== pageId
        || currentTab.grantedDocumentId !== currentSender.documentId)) {
      const registration = await registerTab(currentTab, null, {}, currentSender);
      if (!registration.ok) { await drain(); return registration; }
    }
    const result = await dispatch({ type: 'mori.observation', v: 1, pageInstanceId: 'page-1',
      contentSequence: ++contentSequence, observedAt: Date.now(), status: 'running', generationToken: 'generation-1', outcome: null,
      ...currentTab?.lease, ...patch }, currentSender);
    await drain(); return result;
  }
  return { chrome, log, local, session, tabs, context, drain, observe, dispatch, registerTab, transport: transports[0],
    focusDuring: callback => { onWindowFocus = callback; }, healthDuring: callback => { onHealth = callback; },
    documentCheckDuring: callback => { onDocumentCheck = callback; }, scriptDuring: callback => { onScript = callback; },
    probeDuring: callback => { onProbe = callback; } };
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

function controlledClock() {
  let time = 0, next = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout(callback, delay = 0) { const id = ++next; pending.set(id, { callback, at: time + delay }); return id; },
      clearTimeout(id) { pending.delete(id); },
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, item] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (item.at <= time && pending.delete(id)) item.callback();
      }
    },
  };
}

for (const mode of ['sync-throw', 'reject', 'timeout', 'late-resolve']) {
  test(`initialization remains usable after a browser query ${mode}, and the alarm retries automatically`, async () => {
    const clock = controlledClock();
    const waiting = [];
    const f = await workerFixture({ timers: clock.timers, configureChrome(chrome) {
      chrome.tabs.query = () => {
        if (mode === 'sync-throw') throw new Error('PRIVATE_QUERY_ERROR');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE_QUERY_ERROR'));
        return new Promise(resolve => waiting.push(resolve));
      };
    } });
    clock.advance(1500); await f.drain();
    const sender = { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') };
    const status = await f.dispatch({ type: 'mori.options.status' }, sender);
    assert.equal(status.ok, true);
    assert.equal(status.paired, true);
    assert.equal(f.transport.enabled, true);
    assert.equal(status.diagnostic, mode === 'sync-throw' || mode === 'reject' ? 'tab_query_failed' : 'tab_query_timeout');
    assert.equal(f.local.moriCredential.instanceId, 'instance-1');
    f.tabs.get(7).noReceiver = true;
    if (mode === 'late-resolve') {
      waiting.forEach(resolve => resolve([...f.tabs.values()]));
      await f.drain();
      assert.equal(f.tabs.get(7).noReceiver, true, 'a timed-out query cannot resume recovery later');
    }
    f.chrome.tabs.query = async () => [...f.tabs.values()].map(value => structuredClone(value));
    f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' });
    await f.drain();
    assert.equal(f.tabs.get(7).noReceiver, false);
    assert.equal(f.log.filter(item => item.type === 'observer-inject').length, 1);
    assert.equal((await f.dispatch({ type: 'mori.options.status' }, sender)).diagnostic, null);
  });
}

test('a browser alarm error is not a storage failure and does not block current observations', async () => {
  const f = await workerFixture({ configureChrome(chrome) {
    chrome.alarms.create = async () => { throw new Error('PRIVATE_ALARM_ERROR'); };
  } });
  const status = await f.dispatch({ type: 'mori.options.status' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.equal(status.ok, true);
  assert.equal(status.diagnostic, 'alarm_failed');
  assert.equal((await f.observe()).ok, true);
  f.chrome.alarms.create = async () => {};
  f.chrome.runtime.onStartup.listeners[0](); await f.drain();
  assert.equal((await f.dispatch({ type: 'mori.options.status' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') })).diagnostic, null);
});

for (const [area, method] of [['local', 'get'], ['session', 'get'], ['session', 'set']]) {
  test(`an actual ${area}.${method} initialization failure remains fatal`, async () => {
    const f = await workerFixture({ configureChrome(chrome) {
      chrome.storage[area][method] = async () => { throw new Error('PRIVATE_STORAGE_FAILURE'); };
    } });
    const status = await f.dispatch({ type: 'mori.options.status' },
      { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
    assert.equal(status.ok, false);
    assert.equal(status.connection.code, 'storage_failed');
    assert.equal((await f.observe()).reason, 'storage_failed');
  });
}

test('old reconciliation results do not close newly observed tabs or updated records', async () => {
  const f = await workerFixture();
  await f.observe();
  let release;
  const originalQuery = f.chrome.tabs.query;
  f.chrome.tabs.query = () => new Promise(resolve => { release = resolve; });
  const pending = vm.runInContext('reconcileTabs()', f.context);
  await new Promise(resolve => setImmediate(resolve));
  f.tabs.set(8, { id: 8, windowId: 3, status: 'complete', url: 'https://claude.ai/chat/new-b', pageId: 'page-b' });
  assert.equal((await f.observe({ pageInstanceId: 'page-b' },
    { tab: { id: 8 }, documentId: 'document-b', url: 'https://claude.ai/chat/new-b' })).ok, true);
  assert.equal((await f.observe()).ok, true, 'the old A record has changed while the list was pending');
  f.chrome.tabs.query = originalQuery;
  release([]); await pending; await f.drain();
  assert.deepEqual(Object.keys(f.session.moriSessions.tabs).sort(), ['7', '8']);
  assert.equal(f.transport.events.some(value => value.kind === 'closed'), false);
});

test('a permission-filtered absence or failed query cannot close a still-existing physical tab', async () => {
  const f = await workerFixture(); await f.observe();
  const queries = [];
  f.chrome.tabs.query = async query => { queries.push(structuredClone(query)); return query.url ? [] : [{ id: 7 }]; };
  await vm.runInContext('reconcileTabs()', f.context); await f.drain();
  assert.deepEqual(queries[0], {});
  assert.deepEqual(Object.keys(f.session.moriSessions.tabs), ['7']);
  f.chrome.tabs.query = () => { throw new Error('PRIVATE_ENUMERATION_FAILURE'); };
  await vm.runInContext('reconcileTabs()', f.context); await f.drain();
  assert.deepEqual(Object.keys(f.session.moriSessions.tabs), ['7']);
  assert.equal(f.transport.events.some(value => value.kind === 'closed'), false);
});

test('storage failure while closing an absent tab remains fatal with its durable receipt retained', async () => {
  const f = await workerFixture(); await f.observe();
  const before = f.transport.events.length;
  f.tabs.clear();
  f.chrome.storage.session.set = async () => { throw new Error('PRIVATE_STORAGE_FAILURE'); };
  await assert.rejects(vm.runInContext('reconcileTabs()', f.context), /storage_failed/);
  const status = await f.dispatch({ type: 'mori.options.status' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.equal(status.ok, false);
  assert.equal(status.connection.code, 'storage_failed');
  assert.equal(f.local.moriOutbox.events.length, 1);
  assert.equal(f.local.moriOutbox.events[0].kind, 'closed');
  assert.equal(f.transport.events.length, before);
});

test('a query started before pause cannot inject after pause completes', async () => {
  const f = await workerFixture();
  f.tabs.get(7).noReceiver = true;
  let release;
  f.chrome.tabs.query = () => new Promise(resolve => { release = resolve; });
  const pending = vm.runInContext('requestFreshObservations()', f.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.dispatch({ type: 'mori.options.enabled', enabled: false },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') })).ok, true);
  release([...f.tabs.values()]); await pending; await f.drain();
  assert.equal(f.tabs.get(7).noReceiver, true);
  assert.equal(f.log.filter(item => item.type === 'observer-inject').length, 0);
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
    makeTab(10, { noReceiver: true, injectionError: true }),
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
  assert.deepEqual(f.log.filter(item => item.type === 'health-probe').map(item => item.id), [12, 13, 14, 15]);
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

test('health projects only fixed receipt codes and treats a missing receipt as unconfirmed', async () => {
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

test('diagnostics repair a missing observer in place and independently verify its receipt without finishing the lost turn', async () => {
  const f = await workerFixture();
  const tab = f.tabs.get(7);
  tab.documentId = 'document-1';
  assert.equal((await f.observe()).ok, true);
  const original = f.transport.events.at(-1);
  const credentials = structuredClone(f.local.moriCredential);
  tab.noReceiver = true;
  tab.healthState = 'idle';
  f.healthDuring(async current => {
    current.healthAck = await f.observe({ pageInstanceId: current.pageId, contentSequence: 1,
      status: 'idle', generationToken: null }, { documentId: current.documentId });
  });
  const summary = await f.dispatch({ type: 'mori.options.health' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.deepEqual(structuredClone(summary.observerRecovery),
    { attempted: 1, recovered: 1, deferred: 0, failed: 0, reasons: {} });
  assert.equal(summary.counts.needsReload, 0);
  assert.equal(summary.counts.idle, 1);
  assert.equal(summary.observationDelivery.accepted, 1);
  assert.equal(f.log.filter(item => item.type === 'observer-inject').length, 1);
  const record = Object.values(f.session.moriSessions.sessions).find(value => !value.closed);
  assert.equal(record.sessionId, original.sessionId);
  assert.notEqual(record.pageInstanceId, original.pageInstanceId);
  assert.equal(record.unknownAfterReload, true);
  assert.ok(f.transport.events.every(value => value.kind !== 'terminal'));
  assert.equal(f.local.moriOutbox?.events?.length || 0, 0);
  assert.deepEqual(f.local.moriCredential, credentials);
  assert.equal((await f.observe({ pageInstanceId: original.pageInstanceId })).reason, 'old_document');
  assert.equal(f.log.some(item => item.type === 'tab-focus' || item.type === 'window-focus'), false);
  assert.doesNotMatch(JSON.stringify(summary), /https:|test|document-1|pageInstanceId|conversationRef|key|title/);
});

for (const trigger of ['startup', 'update', 'alarm', 'reconnect', 'retry', 'load-complete', 'thaw']) {
  test(`${trigger} automatically restores a missing observer without a page reload`, async () => {
    const f = await workerFixture();
    f.tabs.get(7).noReceiver = true;
    if (trigger === 'startup') f.chrome.runtime.onStartup.listeners[0]();
    if (trigger === 'update') f.chrome.runtime.onInstalled.listeners[0]({ reason: 'update' });
    if (trigger === 'alarm') f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' });
    if (trigger === 'reconnect') { f.transport.disconnect(); await f.transport.ensureConnected(); }
    if (trigger === 'retry') await f.dispatch({ type: 'mori.options.retry' },
      { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
    if (trigger === 'load-complete') f.chrome.tabs.onUpdated.listeners[0](7, { status: 'complete' });
    if (trigger === 'thaw') f.chrome.tabs.onUpdated.listeners[0](7, { frozen: false });
    await f.drain();
    assert.equal(f.tabs.get(7).noReceiver, false);
    assert.equal(f.log.filter(item => item.type === 'observer-inject').length, 1);
    assert.equal(f.log.some(item => item.type === 'tab-focus' || item.type === 'window-focus'), false);
    assert.equal(f.transport.events.length, 0, 'recovery itself is neither an observation receipt nor a completion');
  });
}

test('worker initialization repairs an old existing tab without waiting for an observation ACK', async () => {
  const f = await workerFixture({ savedTabs: [[7, { id: 7, windowId: 3, status: 'complete',
    url: 'https://chatgpt.com/c/test', pageId: 'old-page', noReceiver: true }]] });
  assert.equal(f.tabs.get(7).noReceiver, false);
  assert.equal(f.log.filter(item => item.type === 'observer-inject').length, 1);
  assert.equal(f.log.filter(item => item.type === 'health-probe').length, 0);
  assert.equal(f.transport.events.length, 0);
});

test('automatic checks and manual diagnostics coalesce, while dead paused/unpaired tabs remain untouched', async () => {
  const f = await workerFixture();
  f.tabs.get(7).noReceiver = true;
  let release;
  f.scriptDuring(options => !options.files && new Promise(resolve => { release = resolve; }));
  f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' });
  await new Promise(resolve => setImmediate(resolve));
  const health = f.dispatch({ type: 'mori.options.health' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  await new Promise(resolve => setImmediate(resolve));
  f.scriptDuring(() => {}); release();
  const summary = await health;
  assert.equal(summary.observerRecovery.recovered, 1);
  assert.equal(f.log.filter(item => item.type === 'observer-inject').length, 1);
  for (const reason of ['paused', 'unpaired']) {
    const blocked = await workerFixture({ savedLocal: { moriClientId: 'profile-1',
      moriSettings: { enabled: reason !== 'paused' } } });
    blocked.tabs.get(7).noReceiver = true;
    const result = await blocked.dispatch({ type: 'mori.options.health' },
      { id: EXTENSION_ID, url: blocked.chrome.runtime.getURL('options.html') });
    assert.equal(result.observerRecovery.deferred, 1);
    assert.equal(result.observerRecovery.reasons[reason], 1);
    assert.equal(result.observerRecovery.attempted, 0);
    assert.equal(blocked.log.some(item => item.type === 'observer-inject' || item.type === 'document-probe'), false);
  }
});

test('health rejects a same-URL replacement during the reply instead of counting an old accepted document', async () => {
  const f = await workerFixture();
  const tab = f.tabs.get(7);
  tab.modernObserver = true;
  tab.healthAck = { ok: true };
  f.healthDuring(current => { current.pageId = 'replacement-page'; current.documentId = 'replacement-document'; });
  const summary = await f.dispatch({ type: 'mori.options.health' },
    { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') });
  assert.equal(summary.counts.unknown, 1);
  assert.equal(summary.observationDelivery.accepted, 0);
  assert.equal(summary.observerRecovery.attempted, 0);
});

test('site access diagnostics are two fixed permission counts, independent of visible tab count', async () => {
  const f = await workerFixture();
  f.tabs.clear();
  f.chrome.permissions.contains = async ({ origins }) => origins[0] !== 'https://claude.ai/*';
  const sender = { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') };
  const summary = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.equal(summary.totalTabs, 0);
  assert.deepEqual(structuredClone(summary.siteAccess), { granted: 1, missing: 1, unknown: 0 });
  assert.deepEqual(structuredClone(summary.observerRecovery),
    { attempted: 0, recovered: 0, deferred: 0, failed: 0, reasons: {} });
  f.chrome.permissions.contains = async () => { throw new Error('PRIVATE_PERMISSION_ERROR'); };
  const unavailable = await f.dispatch({ type: 'mori.options.health' }, sender);
  assert.deepEqual(structuredClone(unavailable.siteAccess), { granted: 0, missing: 0, unknown: 2 });
  assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_|https:|chatgpt|claude/);
});

function optionsSender(f) { return { id: EXTENSION_ID, url: f.chrome.runtime.getURL('options.html') }; }
function contentSender(f, id = 7) {
  const tab = f.tabs.get(id);
  return { id: EXTENSION_ID, frameId: 0, documentLifecycle: 'active',
    documentId: tab.documentId || `document-${id}`, url: tab.url, tab: { id } };
}
function observationFor(f, patch = {}, id = 7) {
  const tab = f.tabs.get(id);
  return { type: 'mori.observation', v: 1, pageInstanceId: tab.pageId,
    contentSequence: 500, observedAt: Date.now(), status: 'running', generationToken: 'generation-boundary',
    outcome: null, ...tab.lease, ...patch };
}

// These confirmed cases test the registration protocol against a deliberately
// explicit boundary stand-in. Real provider DOM confirmation remains unproven.
test('registration has a strict schema and a first observation cannot bypass its worker-issued lease', async () => {
  const f = await workerFixture();
  const tab = f.tabs.get(7);
  for (const patch of [{ extra: 'PRIVATE_REGISTER_FIELD' }, { attemptId: undefined }, { observerVersion: '0.1.6' }]) {
    const refused = await f.registerTab(tab, null, patch);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'invalid_sender');
  }
  const noLease = observationFor(f, { conversationTitle: 'PRIVATE_UNADMITTED' });
  for (const field of ['workerEpoch', 'leaseId', 'bindingEpoch']) delete noLease[field];
  assert.equal((await f.dispatch(noLease, contentSender(f))).reason, 'lease_invalid');
  for (const patch of [{ workerEpoch: 'worker-old' }, { leaseId: 'lease-forged' }, { bindingEpoch: 'binding-old' }]) {
    assert.equal((await f.dispatch(observationFor(f, patch), contentSender(f))).reason, 'lease_invalid');
  }
  assert.equal(f.transport.events.length, 0);
  assert.doesNotMatch(JSON.stringify({ local: f.local, session: f.session }), /PRIVATE_UNADMITTED|PRIVATE_REGISTER_FIELD/);
  assert.equal((await f.dispatch(observationFor(f), contentSender(f))).ok, true);
  const persisted = JSON.stringify({ local: f.local, session: f.session, events: f.transport.events });
  for (const field of ['workerEpoch', 'leaseId', 'bindingEpoch', 'attemptId']) assert.equal(persisted.includes(field), false);
});

test('bootstrap response and a current page ID cannot authorize an unconfirmed conversation or focus', async () => {
  const f = await workerFixture(); await f.observe();
  const record = Object.values(f.session.moriSessions.sessions)[0];
  const request = { type: 'focus.request', v: 1, requestId: 'focus-binding',
    browserRunId: f.session.moriSessions.browserRunId, sessionId: record.sessionId, tabId: 7,
    pageInstanceId: record.pageInstanceId, routeRevision: record.routeRevision,
    conversationRef: record.conversationRef, noticeSequence: null };
  assert.equal((await f.transport.onFocus(request)).ok, true);
  const before = structuredClone(f.session);
  f.tabs.get(7).bindingState = 'unconfirmed';
  const registered = await f.registerTab(f.tabs.get(7));
  assert.equal(registered.reason, 'binding_unconfirmed');
  assert.equal((await f.transport.onFocus(request)).ok, false);
  const refused = await f.dispatch(observationFor(f, { requestPreview: 'PRIVATE_UNBOUND_REQUEST' }), contentSender(f));
  assert.equal(refused.ok, false);
  const health = await f.dispatch({ type: 'mori.options.health' }, optionsSender(f));
  assert.equal(health.counts.unknown, 1);
  assert.equal(health.observerRecovery.recovered, 0);
  assert.equal(health.observerRecovery.reasons.binding_unconfirmed, 1);
  assert.equal(health.observationDelivery.accepted, 0);
  assert.deepEqual(f.session, before);
  assert.doesNotMatch(JSON.stringify(f.session), /PRIVATE_UNBOUND_REQUEST/);
});

for (const control of ['pause', 'unpair']) {
  test(`${control} blocks new admissions immediately even while an earlier options health call is pending`, async () => {
    const f = await workerFixture();
    let release;
    f.healthDuring(() => new Promise(resolve => { release = resolve; }));
    const health = f.dispatch({ type: 'mori.options.health' }, optionsSender(f));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    let finished = false;
    const stopped = f.dispatch(control === 'pause' ? { type: 'mori.options.enabled', enabled: false }
      : { type: 'mori.options.unpair' }, optionsSender(f)).then(value => { finished = true; return value; });
    const refused = await f.dispatch(observationFor(f, { requestPreview: 'PRIVATE_AFTER_STOP_REQUEST' }), contentSender(f));
    assert.equal(refused.reason, 'paused');
    assert.equal(finished, false, 'control response waits for its ordered persistence');
    release(); await health;
    assert.equal((await stopped).ok, true);
    await f.drain();
    assert.doesNotMatch(JSON.stringify({ local: f.local, session: f.session, events: f.transport.events }), /PRIVATE_AFTER_STOP_REQUEST/);
  });

  test(`${control} rejects an observation returning from a pre-commit identity probe`, async () => {
    const f = await workerFixture();
    let release;
    f.documentCheckDuring(() => new Promise(resolve => { release = resolve; }));
    const observed = f.dispatch(observationFor(f, { conversationTitle: 'PRIVATE_DELAYED_IDENTITY' }), contentSender(f));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    const stopped = f.dispatch(control === 'pause' ? { type: 'mori.options.enabled', enabled: false }
      : { type: 'mori.options.unpair' }, optionsSender(f));
    f.documentCheckDuring(() => {}); release();
    assert.equal((await observed).ok, false);
    assert.equal((await stopped).ok, true);
    await f.drain();
    assert.equal(f.transport.events.length, 0);
    assert.doesNotMatch(JSON.stringify({ local: f.local, session: f.session }), /PRIVATE_DELAYED_IDENTITY/);
  });

  test(`${control} waits for a terminal commit already writing its durable receipt`, async () => {
    const f = await workerFixture(); await f.observe();
    f.transport.canConnect = false; f.transport.disconnect();
    const originalSet = f.chrome.storage.local.set;
    let release;
    f.chrome.storage.local.set = async value => {
      await originalSet(value);
      if (value.moriOutbox?.events.some(event => event.kind === 'terminal')) await new Promise(resolve => { release = resolve; });
    };
    const observed = f.dispatch(observationFor(f, { status: 'settled', generationToken: 'generation-1',
      outcome: 'unverified' }), contentSender(f));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.local.moriOutbox.events.length, 1);
    assert.equal(Object.values(f.session.moriSessions.sessions)[0].phase, 'running');
    let finished = false;
    const stopped = f.dispatch(control === 'pause' ? { type: 'mori.options.enabled', enabled: false }
      : { type: 'mori.options.unpair' }, optionsSender(f)).then(value => { finished = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    f.chrome.storage.local.set = originalSet; release();
    assert.equal((await observed).ok, true, 'the already-started operation settles before the control');
    assert.equal((await stopped).ok, true);
    const writes = f.log.filter(item => item.type === 'save').length;
    await f.drain();
    assert.equal(f.log.filter(item => item.type === 'save').length, writes, 'no late old commit after the success response');
    if (control === 'pause') {
      assert.equal(f.local.moriOutbox.events.length, 1);
      assert.equal(f.local.moriOutbox.events[0].kind, 'terminal');
      assert.equal(Object.values(f.session.moriSessions.sessions)[0].phase, 'settled');
    } else {
      assert.equal(f.local.moriCredential, null);
      assert.equal(f.local.moriOutbox.events.length, 0);
      assert.deepEqual(Object.keys(f.session.moriSessions.sessions), []);
    }
  });
}

test('a late transport ACK cannot write back or resend after unpair succeeds', async () => {
  const f = await workerFixture(); await f.observe();
  f.transport.canConnect = false; f.transport.disconnect();
  await f.observe({ status: 'settled', outcome: 'unverified' });
  const originalSend = f.transport.sendEvent.bind(f.transport);
  let release;
  f.transport.sendEvent = async value => {
    const ack = await originalSend(value);
    if (value.kind === 'terminal') await new Promise(resolve => { release = resolve; });
    return ack;
  };
  f.transport.canConnect = true; await f.transport.ensureConnected(); await f.drain();
  assert.equal(typeof release, 'function');
  assert.equal((await f.dispatch({ type: 'mori.options.unpair' }, optionsSender(f))).ok, true);
  const after = f.log.length;
  release(); await f.drain();
  assert.equal(f.log.slice(after).some(entry => entry.type === 'save' || entry.type === 'send'), false);
  assert.equal(f.local.moriCredential, null);
  assert.equal(f.local.moriOutbox.events.length, 0);
  assert.deepEqual(Object.keys(f.session.moriSessions.sessions), []);
});

test('reconciliation rechecks admission between individual closed-record commits', async () => {
  const f = await workerFixture(); await f.observe();
  f.tabs.set(8, { id: 8, windowId: 3, status: 'complete', url: 'https://chatgpt.com/c/second',
    pageId: 'page-8', documentId: 'document-8' });
  await f.observe({ pageInstanceId: 'page-8' }, contentSender(f, 8));
  f.transport.canConnect = false; f.transport.disconnect();
  f.tabs.clear();
  const originalSet = f.chrome.storage.session.set;
  let release;
  f.chrome.storage.session.set = async value => {
    await originalSet(value);
    if (Object.values(value.moriSessions?.sessions || {}).some(record => record.closed)) {
      await new Promise(resolve => { release = resolve; });
    }
  };
  const reconciled = vm.runInContext('reconcileTabs()', f.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function');
  const paused = f.dispatch({ type: 'mori.options.enabled', enabled: false }, optionsSender(f));
  f.chrome.storage.session.set = originalSet; release();
  await reconciled; assert.equal((await paused).ok, true); await f.drain();
  assert.equal(f.local.moriOutbox.events.filter(event => event.kind === 'closed').length, 1);
  assert.equal(Object.keys(f.session.moriSessions.tabs).length, 1);
});

for (const phase of ['bundle', 'start', 'granted-start']) {
  test(`a ${phase} resolving after its four-second timeout cannot authorize late observation`, async () => {
    const clock = controlledClock();
    const f = await workerFixture({ timers: clock.timers });
    const tab = f.tabs.get(7); tab.noReceiver = true;
    const execute = f.chrome.scripting.executeScript;
    let release, lateResult;
    f.chrome.scripting.executeScript = options => {
      if ((phase === 'bundle' && options.files) || (phase !== 'bundle' && options.args)) {
        return new Promise(resolve => { release = async () => {
          lateResult = await execute(options); resolve(lateResult);
        }; });
      }
      return execute(options);
    };
    if (phase === 'granted-start') {
      f.chrome.scripting.executeScript = async options => {
        const result = await execute(options);
        if (options.args) await new Promise(resolve => { release = () => { lateResult = result; resolve(); }; });
        return result;
      };
    }
    f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' });
    await f.drain();
    assert.equal(typeof release, 'function');
    clock.advance(4000); await f.drain();
    await release(); await f.drain();
    if (phase === 'bundle') {
      assert.equal(tab.noReceiver, true, 'loading installer files alone cannot start the observer');
      assert.equal(f.log.filter(entry => entry.type === 'observer-start').length, 0);
    } else {
      if (phase === 'start') assert.equal(lateResult[0].result.reason, 'attempt_expired');
      const refused = await f.dispatch(observationFor(f, { requestPreview: 'PRIVATE_LATE_START' }), contentSender(f));
      assert.equal(refused.reason, 'lease_invalid');
    }
    assert.equal(f.transport.events.length, 0);
    assert.doesNotMatch(JSON.stringify({ local: f.local, session: f.session }), /PRIVATE_LATE_START/);
  });
}

test('worker renewal changes the grant epoch without inventing a new turn for a continuous observer', async () => {
  const first = await workerFixture(); await first.observe();
  const original = first.transport.events.at(-1);
  const originalLease = { ...first.tabs.get(7).lease };
  const restarted = await workerFixture({ savedLocal: first.local, savedSession: first.session, savedTabs: [...first.tabs] });
  const newLease = restarted.tabs.get(7).lease;
  assert.notEqual(newLease.workerEpoch, originalLease.workerEpoch);
  const stale = await restarted.dispatch(observationFor(restarted, { ...originalLease }), contentSender(restarted));
  assert.equal(stale.reason, 'lease_invalid');
  const completed = await restarted.dispatch(observationFor(restarted, { status: 'settled', generationToken: 'generation-1',
    outcome: 'unverified' }), contentSender(restarted));
  assert.equal(completed.ok, true); await restarted.drain();
  const terminals = restarted.transport.events.filter(event => event.kind === 'terminal');
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].sessionId, original.sessionId);
  assert.equal(terminals[0].turnId, original.turnId);
  assert.equal(terminals[0].generation, original.generation);
  assert.equal(Object.keys(restarted.session.moriSessions.sessions).length, 1);
});

for (const control of ['pause', 'unpair', 'navigation', 'replacement']) {
  test(`a delayed start is refused after ${control}, even when Chrome eventually executes its fixed function`, async () => {
    const f = await workerFixture(); const tab = f.tabs.get(7); tab.noReceiver = true;
    const execute = f.chrome.scripting.executeScript;
    let release, lateResult;
    f.chrome.scripting.executeScript = options => options.args
      ? new Promise((resolve, reject) => { release = async () => {
        try { lateResult = await execute(options); resolve(lateResult); }
        catch (error) { reject(error); throw error; }
      }; })
      : execute(options);
    f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' }); await f.drain();
    assert.equal(typeof release, 'function');
    if (control === 'pause' || control === 'unpair') {
      assert.equal((await f.dispatch(control === 'pause' ? { type: 'mori.options.enabled', enabled: false }
        : { type: 'mori.options.unpair' }, optionsSender(f))).ok, true);
    } else {
      if (control === 'navigation') tab.url = 'https://chatgpt.com/c/new-conversation';
      else tab.documentId = 'replacement-document';
      f.chrome.tabs.onUpdated.listeners[0](7, { status: 'loading' });
    }
    // Replacement cannot execute in the old exact document at all.
    if (control === 'replacement') {
      await assert.rejects(release(), /no_document/);
      f.chrome.scripting.executeScript = execute;
      await f.drain();
      return;
    }
    await release(); await f.drain();
    assert.equal(lateResult[0].result.ok, false);
    assert.equal(f.transport.events.length, 0);
    assert.equal(f.local.moriOutbox?.events?.length || 0, 0);
  });
}

test('attempts expire before timeout diagnosis, even if the diagnostic tab lookup hangs', async () => {
  const clock = controlledClock();
  const f = await workerFixture({ timers: clock.timers }); const tab = f.tabs.get(7); tab.noReceiver = true;
  const execute = f.chrome.scripting.executeScript;
  const get = f.chrome.tabs.get;
  let releaseStart, releaseDiagnostic, lateResult;
  f.chrome.scripting.executeScript = options => options.args
    ? new Promise(resolve => { releaseStart = async () => { lateResult = await execute(options); resolve(lateResult); }; })
    : execute(options);
  f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' }); await f.drain();
  f.chrome.tabs.get = () => new Promise(resolve => { releaseDiagnostic = () => resolve({ ...tab }); });
  clock.advance(4000); await f.drain();
  assert.equal(typeof releaseDiagnostic, 'function');
  await releaseStart(); await f.drain();
  assert.equal(lateResult[0].result.reason, 'attempt_expired');
  assert.equal(f.transport.events.length, 0);
  f.chrome.tabs.get = get; releaseDiagnostic(); await f.drain();
});

test('an expired old start cannot revoke a newer owner that already received a valid grant', async () => {
  const clock = controlledClock();
  const f = await workerFixture({ timers: clock.timers }); const tab = f.tabs.get(7); tab.noReceiver = true;
  const execute = f.chrome.scripting.executeScript;
  let release, lateResult;
  f.chrome.scripting.executeScript = options => options.args
    ? new Promise(resolve => { release = async () => { lateResult = await execute(options); resolve(lateResult); }; })
    : execute(options);
  f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' }); await f.drain();
  clock.advance(4000); await f.drain();
  tab.noReceiver = false; tab.pageId = 'new-owner'; tab.lease = null;
  assert.equal((await f.registerTab(tab)).ok, true);
  const lease = { ...tab.lease };
  await release(); await f.drain();
  assert.equal(lateResult[0].result.reason, 'attempt_expired');
  assert.deepEqual(tab.lease, lease);
  assert.equal((await f.dispatch(observationFor(f), contentSender(f))).ok, true);
});

test('the final focus reply cannot acknowledge A after its tab changes to B while the reply is in flight', async () => {
  const f = await workerFixture(); await f.observe();
  const record = Object.values(f.session.moriSessions.sessions)[0];
  const request = { type: 'focus.request', v: 1, requestId: 'focus-last-reply',
    browserRunId: f.session.moriSessions.browserRunId, sessionId: record.sessionId, tabId: 7,
    pageInstanceId: record.pageInstanceId, routeRevision: record.routeRevision,
    conversationRef: record.conversationRef, noticeSequence: null };
  let focusReplies = 0;
  f.documentCheckDuring((tab, message) => {
    // The stand-in has already computed A's ok reply. No onUpdated event is
    // delivered; only the subsequent browser tab lookup can see this change.
    if (message.type === 'mori.focus.check' && ++focusReplies === 2) tab.url = 'https://chatgpt.com/c/conversation-b';
  });
  const result = await f.transport.onFocus(request);
  assert.equal(focusReplies, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session_changed');
});

test('resuming after a tab closed during pause eventually closes only that physical session', async () => {
  const f = await workerFixture(); await f.observe();
  const original = f.transport.events.at(-1);
  assert.equal((await f.dispatch({ type: 'mori.options.enabled', enabled: false }, optionsSender(f))).ok, true);
  f.tabs.delete(7); f.chrome.tabs.onRemoved.listeners[0](7); await f.drain();
  assert.equal((await f.dispatch({ type: 'mori.options.enabled', enabled: true }, optionsSender(f))).ok, true);
  f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' }); await f.drain();
  const closed = f.transport.events.filter(event => event.kind === 'closed');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].sessionId, original.sessionId);
  assert.equal(f.transport.events.some(event => event.kind === 'terminal'), false);
  assert.deepEqual(Object.keys(f.session.moriSessions.tabs), []);
});

test('the automatic alarm reconciles a physically absent saved tab after startup enumeration failed', async () => {
  const first = await workerFixture(); await first.observe();
  const f = await workerFixture({ savedLocal: first.local, savedSession: first.session, savedTabs: [],
    configureChrome(chrome) { chrome.tabs.query = async () => { throw new Error('PRIVATE_FIRST_QUERY_FAILURE'); }; } });
  assert.equal(Object.keys(f.session.moriSessions.tabs).length, 1);
  f.chrome.tabs.query = async () => [];
  f.chrome.alarms.onAlarm.listeners[0]({ name: 'mori-reconnect' }); await f.drain();
  assert.equal(f.transport.events.filter(event => event.kind === 'closed').length, 1);
  assert.deepEqual(Object.keys(f.session.moriSessions.tabs), []);
});
