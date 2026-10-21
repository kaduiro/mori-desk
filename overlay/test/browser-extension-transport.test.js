const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createBrowserBridge } = require('../src/browser-bridge-server');
const { EXTENSION_ID } = require('../src/browser-bridge-protocol');
const { Transport, PORTS } = require('../extensions/browser-bridge/transport');

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`test-vault:${value}`),
  decryptString: value => value.toString('utf8').slice(11),
};
async function listen(server) {
  for (const port of [...PORTS].reverse()) {
    const bound = await new Promise((resolve, reject) => {
      function error(cause) { server.removeListener('listening', listening); if (cause.code === 'EADDRINUSE') resolve(false); else reject(cause); }
      function listening() { server.removeListener('error', error); resolve(true); }
      server.once('error', error); server.once('listening', listening); server.listen(port, '127.0.0.1');
    });
    if (bound) return port;
  }
  throw new Error('No free MORI test port in 23333–23337');
}
async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mori-extension-transport-'));
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const bridge = createBrowserBridge({ dataDir, safeStorage: fakeSafeStorage });
  bridge.attach(server);
  const port = await listen(server);
  const wire = [];
  const sockets = [];
  class ExtensionWebSocket extends WebSocket {
    constructor(url) { super(url, { origin: `chrome-extension://${EXTENSION_ID}` }); sockets.push(this); }
    send(data, ...args) { wire.push(JSON.parse(data)); return super.send(data, ...args); }
  }
  let credential = null;
  const saveLog = [];
  const statuses = [];
  const transports = [];
  function make(extra = {}) {
    const instance = new Transport({ clientId: 'extension-profile', browserRunId: 'browser-run',
      getCredential: () => credential,
      saveCredential: async value => {
        if (options.failSave) throw new Error('storage_failed');
        saveLog.push(value); credential = value;
      },
      onStatus: value => statuses.push(value), cryptoApi: crypto.webcrypto, WebSocketClass: ExtensionWebSocket, ...extra });
    transports.push(instance); return instance;
  }
  t.after(async () => {
    transports.forEach(item => { item.enabled = false; item.disconnect(); });
    sockets.forEach(socket => socket.terminate());
    bridge.dispose();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const event = patch => ({ type: 'event', v: 1, eventId: 'observation-1', browserRunId: 'browser-run',
    sessionId: 'tab-session', sequence: 1, kind: 'observation', provider: 'chatgpt', tabId: 7,
    pageInstanceId: 'page-1', routeRevision: 0, conversationRef: '/c/test', turnId: 'turn-1', generation: 1,
    phase: 'running', outcome: null, observation: 'fresh', observedAt: Date.now(), replay: false, ...patch });
  return { bridge, port, make, wire, saveLog, statuses, event, getCredential: () => credential };
}

test('extension transport pairs against the real backend, then reconnects with the saved derived key', async t => {
  const f = await fixture(t);
  const first = f.make();
  const code = f.bridge.beginPairing(f.port).code;
  const pairSecret = JSON.parse(Buffer.from(code.slice(6), 'base64url')).secret;
  await first.pair(code);
  assert.equal(first.isReady(), true);
  assert.equal(f.saveLog.length, 1);
  assert.equal(f.wire.findIndex(item => item.type === 'pair.confirm') > f.wire.findIndex(item => item.type === 'authenticate'), true);
  assert.equal(f.wire.some(item => JSON.stringify(item).includes(pairSecret)), false);
  assert.equal(f.wire.some(item => JSON.stringify(item).includes(f.getCredential().key)), false);
  await first.sendEvent(f.event());
  assert.equal(f.bridge.getSnapshot()[0].provider, 'chatgpt');
  first.enabled = false; first.disconnect();
  const resumed = f.make(); await resumed.ensureConnected();
  assert.equal(resumed.isReady(), true);
  assert.equal(f.wire.filter(item => item.type === 'hello').at(-1).mode, 'resume');
});

test('a failed extension credential write never sends pair.confirm or reports ready', async t => {
  const f = await fixture(t, { failSave: true });
  const instance = f.make();
  await assert.rejects(instance.pair(f.bridge.beginPairing(f.port).code), /storage_failed/);
  assert.equal(instance.isReady(), false);
  assert.equal(f.wire.some(item => item.type === 'pair.confirm'), false);
  assert.equal(f.statuses.some(status => status.state === 'connected'), false);
});

test('real metadata terminal ACK and focus round-trip do not need any input or approval capability', async t => {
  const f = await fixture(t);
  const requests = [];
  const instance = f.make({ onFocus: async request => { requests.push(request); return { ok: true }; } });
  await instance.pair(f.bridge.beginPairing(f.port).code);
  await instance.sendEvent(f.event());
  const terminal = f.event({ eventId: 'terminal-1', sequence: 2, kind: 'terminal', phase: 'settled', outcome: 'unverified' });
  const ack = await instance.sendEvent(terminal);
  assert.equal(ack.eventId, terminal.eventId);
  const row = f.bridge.getSnapshot()[0];
  assert.equal(row.requiresCompletionAck, true);
  const result = await f.bridge.focus(row.id, row.noticeSequence);
  assert.equal(result.ok, true);
  assert.equal(requests[0].pageInstanceId, 'page-1');
  assert.equal(f.bridge.getSnapshot()[0].requiresCompletionAck, false);
  assert.equal(f.wire.some(item => ['input', 'approve', 'permission'].includes(item.type)), false);
});

function offlineRetryFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0);
  const urls = [];
  let credential = { clientId: 'extension-profile', instanceId: 'desktop-instance',
    port: 23334, key: crypto.randomBytes(32).toString('base64url') };
  class OfflineWebSocket {
    constructor(url) {
      urls.push(url);
      queueMicrotask(() => this.onerror?.());
    }
    close() {}
  }
  const transport = new Transport({ clientId: 'extension-profile', browserRunId: 'browser-run',
    getCredential: () => credential, saveCredential: async () => {},
    cryptoApi: crypto.webcrypto, WebSocketClass: OfflineWebSocket });
  t.after(() => { transport.enabled = false; transport.disconnect(); });
  return { transport, urls, forgetCredential: () => { credential = null; } };
}

test('automatic reconnect calls from observations respect the pending exponential backoff', async t => {
  const { transport, urls } = offlineRetryFixture(t);
  await transport.ensureConnected();
  assert.deepEqual(urls, [23334, 23333, 23335, 23336, 23337]
    .map(port => `ws://127.0.0.1:${port}/browser/v1`));
  const firstTimer = transport.reconnectTimer;
  assert.ok(firstTimer);
  for (let i = 0; i < 20; i++) await transport.ensureConnected();
  assert.equal(urls.length, 5, 'fresh DOM observations must not start another port scan');
  assert.equal(transport.reconnectTimer, firstTimer);
  assert.equal(transport.attempt, 1);

  t.mock.timers.tick(999);
  await transport.ensureConnected();
  assert.equal(urls.length, 5);
  t.mock.timers.tick(1);
  await transport.connecting;
  assert.equal(urls.length, 10, 'the scheduled retry still runs at its deadline');
  for (let i = 0; i < 20; i++) await transport.ensureConnected();
  assert.equal(urls.length, 10);
  t.mock.timers.tick(1999);
  assert.equal(urls.length, 10);
  t.mock.timers.tick(1);
  await transport.connecting;
  assert.equal(urls.length, 15, 'the next retry keeps its increased delay');
  assert.equal(transport.attempt, 3);
});

test('explicit retry cancels the pending wait and coalesces concurrent connection attempts', async t => {
  const { transport, urls } = offlineRetryFixture(t);
  await transport.ensureConnected();
  assert.equal(urls.length, 5);
  await Promise.all([
    transport.ensureConnected({ immediate: true }),
    transport.ensureConnected({ immediate: true }),
  ]);
  assert.equal(urls.length, 10, 'one explicit action starts exactly one new port scan');
  assert.equal(transport.attempt, 2, 'an unsuccessful manual retry does not reset backoff');
  t.mock.timers.tick(1000);
  await transport.connecting;
  assert.equal(urls.length, 10, 'the cancelled earlier timer must not fire');
  t.mock.timers.tick(1000);
  await transport.connecting;
  assert.equal(urls.length, 15, 'automatic recovery remains scheduled after the manual failure');
});

test('explicit retry does not bypass paused, pairing or unpaired states', async t => {
  const { transport, urls, forgetCredential } = offlineRetryFixture(t);
  transport.setEnabled(false);
  await transport.ensureConnected({ immediate: true });
  assert.equal(urls.length, 0);
  transport.enabled = true; transport.pairing = true;
  await transport.ensureConnected({ immediate: true });
  assert.equal(urls.length, 0);
  transport.pairing = false; forgetCredential();
  await transport.ensureConnected({ immediate: true });
  assert.equal(urls.length, 0);
  assert.equal(transport.reconnectTimer, null);
});

test('resumption still finds a moved desktop port and authenticates its saved key', async t => {
  const f = await fixture(t);
  const first = f.make();
  await first.pair(f.bridge.beginPairing(f.port).code);
  first.enabled = false; first.disconnect();
  const stalePort = PORTS.find(port => port !== f.port);
  const saved = { ...f.getCredential(), port: stalePort };
  const attempted = [];
  class MovedDesktopWebSocket extends WebSocket {
    constructor(url) {
      const port = Number(new URL(url).port);
      attempted.push(port);
      // Keep the actual authentication exchange on our owned test server;
      // other ports behave as offline without probing unrelated listeners.
      if (port !== f.port) throw new Error('test_offline');
      super(url, { origin: `chrome-extension://${EXTENSION_ID}` });
    }
  }
  const resumed = f.make({ getCredential: () => saved, WebSocketClass: MovedDesktopWebSocket });
  await resumed.ensureConnected();
  assert.equal(resumed.isReady(), true);
  assert.equal(attempted[0], stalePort);
  assert.equal(attempted.at(-1), f.port);
  assert.equal(new Set(attempted).size, attempted.length);
  assert.equal(f.getCredential().port, f.port);
  assert.equal(f.getCredential().key, saved.key);
});

// No browser or provider fixture is involved here. The socket implements the
// documented HMAC exchange, and the test controls only when a credential-save
// callback completes. Status, wire messages and heartbeat installation are the
// observable effects; the transport's internal stage is not the oracle.
function delayedAuthenticationFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const statuses = [], wire = [], saves = [], sockets = [];
  let readyCalls = 0, heartbeatStarts = 0;
  const interval = global.setInterval;
  t.mock.method(global, 'setInterval', (...args) => { heartbeatStarts++; return interval(...args); });
  let credential = { clientId: 'race-profile', instanceId: 'race-desktop', port: 23333,
    key: Buffer.alloc(32, 17).toString('base64url') };
  let enterSave, releaseSave;
  const saveEntered = new Promise(resolve => { enterSave = resolve; });
  const saveBarrier = new Promise(resolve => { releaseSave = resolve; });
  const proof = (label, challenge) => crypto.createHmac('sha256', Buffer.from(credential.key, 'base64url'))
    .update(JSON.stringify(['mori-desk/browser/v1', label, 1, challenge.mode,
      challenge.credentialId, challenge.clientId, challenge.productId, challenge.instanceId,
      challenge.serverRunId, challenge.port, challenge.clientNonce, challenge.serverNonce]))
    .digest('base64url');
  class SignedSocket {
    constructor(url) {
      this.port = Number(new URL(url).port); this.closed = false;
      sockets.push(this); queueMicrotask(() => this.onopen?.());
    }
    send(text) {
      const message = JSON.parse(text);
      wire.push({ port: this.port, closed: this.closed, type: message.type });
      if (this.closed) throw new Error('socket_closed');
      if (message.type === 'hello') {
        this.challenge = { type: 'challenge', v: 1, mode: 'resume',
          credentialId: message.credentialId, clientId: message.clientId, productId: 'mori-desk',
          instanceId: message.instanceId, serverRunId: `server-${this.port}`, port: this.port,
          clientNonce: message.clientNonce, serverNonce: Buffer.alloc(32, this.port % 256).toString('base64url') };
        this.challenge.proof = proof('server-proof', this.challenge);
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(this.challenge) }));
      } else if (message.type === 'authenticate') {
        assert.equal(message.proof, proof('client-proof', this.challenge));
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready', v: 1,
          clientId: credential.clientId, instanceId: credential.instanceId,
          serverRunId: this.challenge.serverRunId, port: this.port }) }));
      }
    }
    close() { this.closed = true; }
  }
  const transport = new Transport({ clientId: credential.clientId, browserRunId: 'race-browser',
    getCredential: () => credential,
    saveCredential: async value => {
      // Model a persisted write whose completion reply has not yet arrived.
      // Do not introduce a reverse-write race owned by the worker's queue.
      credential = value; saves.push(value);
      if (saves.length === 1) { enterSave(); await saveBarrier; }
    },
    onStatus: value => statuses.push(value), onReady: () => { readyCalls++; },
    cryptoApi: crypto.webcrypto, WebSocketClass: SignedSocket });
  t.after(() => { transport.setEnabled(false); releaseSave(); });
  const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)); };
  const connect = port => {
    // Capture rejection immediately: invalidation intentionally settles this
    // promise before the old asynchronous save is released.
    const result = transport.connectOne(port).then(() => ({ ok: true }), error => ({ ok: false, reason: error.message }));
    return result;
  };
  return { transport, connect, saveEntered, releaseSave, settle, statuses, wire, saves, sockets,
    effects: () => ({ readyCalls, heartbeatStarts }) };
}

test('a late credential-save completion cannot report connected after monitoring is paused', async t => {
  const f = delayedAuthenticationFixture(t);
  const pending = f.connect(23334);
  await f.saveEntered;
  f.transport.setEnabled(false);
  const countAtPause = f.statuses.length;
  assert.equal(f.statuses.at(-1).state, 'paused');
  f.releaseSave(); await f.settle();
  assert.deepEqual(await pending, { ok: false, reason: 'paused' });
  assert.equal(f.transport.isReady(), false);
  assert.equal(f.statuses.length, countAtPause, 'the closed socket must not overwrite paused status');
  assert.deepEqual(f.effects(), { readyCalls: 0, heartbeatStarts: 0 });
  assert.equal(f.wire.some(item => item.closed), false);
});

test('an expired authentication cannot become ready when its delayed save completes', async t => {
  const f = delayedAuthenticationFixture(t);
  const pending = f.connect(23334);
  await f.saveEntered;
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, { ok: false, reason: 'authentication_timeout' });
  f.releaseSave(); await f.settle();
  assert.equal(f.transport.isReady(), false);
  assert.equal(f.statuses.some(item => item.state === 'connected'), false);
  assert.deepEqual(f.effects(), { readyCalls: 0, heartbeatStarts: 0 });
});

test('a replaced socket cannot publish ready over its authenticated replacement', async t => {
  const f = delayedAuthenticationFixture(t);
  const old = f.connect(23334);
  await f.saveEntered;
  f.transport.disconnect('replacement');
  assert.deepEqual(await old, { ok: false, reason: 'replacement' });
  assert.deepEqual(await f.connect(23335), { ok: true });
  assert.equal(f.transport.isReady(), true);
  assert.deepEqual(f.effects(), { readyCalls: 1, heartbeatStarts: 1 });
  const statusCount = f.statuses.length;
  f.releaseSave(); await f.settle();
  assert.equal(f.transport.isReady(), true);
  assert.equal(f.statuses.length, statusCount, 'late old ready must not replace the new connection status');
  assert.equal(f.statuses.at(-1).port, 23335);
  assert.deepEqual(f.effects(), { readyCalls: 1, heartbeatStarts: 1 });
  assert.equal(f.wire.some(item => item.closed), false);
});

test('a current delayed credential save still completes authentication exactly once', async t => {
  const f = delayedAuthenticationFixture(t);
  const pending = f.connect(23334);
  await f.saveEntered;
  assert.equal(f.transport.isReady(), false);
  assert.deepEqual(f.effects(), { readyCalls: 0, heartbeatStarts: 0 });
  f.releaseSave();
  assert.deepEqual(await pending, { ok: true });
  assert.equal(f.transport.isReady(), true);
  assert.equal(f.statuses.filter(item => item.state === 'connected').length, 1);
  assert.equal(f.statuses.at(-1).port, 23334);
  assert.deepEqual(f.effects(), { readyCalls: 1, heartbeatStarts: 1 });
});

test('pausing from the connected status callback stops readiness and still permits a later connection', async t => {
  const f = delayedAuthenticationFixture(t);
  const recordStatus = f.transport.onStatus;
  let pauseOnce = true;
  f.transport.onStatus = status => {
    recordStatus(status);
    if (status.state === 'connected' && pauseOnce) {
      pauseOnce = false;
      f.transport.setEnabled(false);
    }
  };
  const result = await f.connect(23333);
  await f.settle();
  assert.deepEqual(f.effects(), { readyCalls: 0, heartbeatStarts: 0 });
  assert.deepEqual(result, { ok: false, reason: 'paused' }, 'the interrupted authentication promise must settle');
  assert.equal(f.transport.isReady(), false);
  assert.equal(f.statuses.at(-1).state, 'paused');

  f.transport.setEnabled(true);
  await f.transport.connecting;
  assert.equal(f.transport.isReady(), true);
  assert.deepEqual(f.effects(), { readyCalls: 1, heartbeatStarts: 1 });
});

test('an obsolete pair completion cannot release the current pair exclusion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const credential = { clientId: 'pair-profile', instanceId: 'pair-desktop', port: 23333,
    key: Buffer.alloc(32, 23).toString('base64url') };
  class PendingSocket {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; }
  }
  const transport = new Transport({ clientId: credential.clientId, browserRunId: 'pair-browser',
    getCredential: () => credential, saveCredential: async () => {},
    cryptoApi: crypto.webcrypto, WebSocketClass: PendingSocket });
  t.after(() => {
    transport.setEnabled(false);
    for (const socket of sockets) socket.onclose?.();
  });
  const begin = pairingId => transport.pair('mori1:' + Buffer.from(JSON.stringify({
    v: 1, productId: 'mori-desk', instanceId: credential.instanceId, pairingId,
    port: 23333, secret: credential.key, expiresAt: Date.now() + 120000,
  })).toString('base64url')).then(() => ({ ok: true }), error => ({ ok: false, reason: error.message }));
  const old = begin('pair-first');
  const current = begin('pair-second');
  assert.deepEqual(await old, { ok: false, reason: 'pairing' });
  assert.equal(sockets.length, 2);
  const retry = transport.ensureConnected({ immediate: true });
  retry.catch(() => {});
  assert.equal(sockets.length, 2, 'retry must not open a resume socket while the replacement pair is pending');
  await retry;
  assert.equal(sockets[1].closed, undefined);

  sockets[1].onerror();
  assert.deepEqual(await current, { ok: false, reason: 'connection_failed' });
  const resumed = transport.ensureConnected({ immediate: true });
  assert.equal(sockets.length, 3, 'the current pair completion must release its own exclusion');
  transport.setEnabled(false);
  await resumed;
});
