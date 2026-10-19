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
