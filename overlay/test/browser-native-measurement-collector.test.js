'use strict';
// Synthetic vault + dedicated temporary data directory + real loopback bridge.
// These are collector regression tests, not independent native acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const WebSocket = require('ws');
const { createNativeCollector } = require('../scripts/native-measurement-collector');
const EXTENSION = 'obooegdoanifidoffaodpobadpeiilcl';
const syntheticVault = {
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'synthetic-test-only',
  encryptString: text => Buffer.from(text, 'utf8'), decryptString: bytes => bytes.toString('utf8'),
};
function mac(key, label, c) {
  return crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(JSON.stringify([
    'mori-desk/browser/v1', label, 1, c.mode, c.credentialId, c.clientId, c.productId,
    c.instanceId, c.serverRunId, c.port, c.clientNonce, c.serverNonce,
  ])).digest('base64url');
}
async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(__dirname, '..', '..', '.tmp-native-collector-test-'));
  const collector = createNativeCollector({ dataDir, safeStorage: syntheticVault, ...options });
  t.after(async () => { await collector.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { collector, dataDir };
}
async function start(t, options) {
  const f = await fixture(t, options); const started = await f.collector.start();
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok([23337, 23336, 23335, 23334, 23333].includes(started.port));
  return { ...f, port: started.port };
}
function messages(socket) {
  const waiting = [], queued = [];
  socket.on('message', raw => { const value = JSON.parse(raw.toString()); if (waiting.length) waiting.shift()(value); else queued.push(value); });
  return async () => queued.length ? queued.shift() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('loopback response timeout')), 3000);
    waiting.push(value => { clearTimeout(timer); resolve(value); });
  });
}
async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('collector state timeout');
    await new Promise(resolve => setImmediate(resolve));
  }
}
async function connect(t, f, pairing = f.collector.beginPairing(), { clientId = 'synthetic-client', browserRunId = 'synthetic-run' } = {}) {
  assert.equal(pairing.ok, true);
  const code = JSON.parse(Buffer.from(pairing.code.slice(6), 'base64url'));
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: `chrome-extension://${EXTENSION}` });
  const next = messages(socket);
  socket.on('error', () => {}); t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', v: 1, mode: 'pair', clientId, browserRunId,
    instanceId: code.instanceId, credentialId: code.pairingId, clientNonce: Buffer.alloc(32, 7).toString('base64url') }));
  const challenge = await next(); assert.equal(challenge.type, 'challenge');
  assert.equal(challenge.proof, mac(code.secret, 'server-proof', challenge));
  socket.send(JSON.stringify({ type: 'authenticate', proof: mac(code.secret, 'client-proof', challenge) }));
  assert.equal((await next()).type, 'pair.ready');
  const key = mac(code.secret, 'credential', challenge);
  socket.send(JSON.stringify({ type: 'pair.confirm', proof: mac(key, 'pair-confirm', challenge) }));
  assert.equal((await next()).type, 'ready');
  return { socket, next };
}
function event(sequence = 1, extra = {}) {
  return { type: 'scope.event', v: 1, schema: 2, eventId: `synthetic-event-${sequence}`, browserRunId: 'synthetic-run',
    sessionId: 'synthetic-session', sequence, kind: 'observation', provider: 'chatgpt', tabId: 45,
    pageInstanceId: 'synthetic-page', routeRevision: 1, conversationRef: '/c/synthetic-conversation', turnId: null,
    generation: 0, phase: 'idle', outcome: null, observation: 'fresh', observedAt: Date.now(), replay: false,
    conversationTitle: 'PRIVATE_SENTINEL_TITLE', requestPreview: 'PRIVATE_SENTINEL_PREVIEW', gap: null,
    scope: { kind: 'conversation', viewEpoch: 'view', bindingEpoch: 'binding', samplingEpoch: 'sampling',
      workerEpoch: 'worker', leaseId: 'lease', documentId: 'document', startUnobserved: false }, ...extra };
}

test('disabled by loading; explicit factory/start; secure storage and dedicated empty directory fail closed', async t => {
  const f = await fixture(t, { safeStorage: undefined });
  assert.equal(f.collector.snapshot().status, 'idle');
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  assert.equal((await f.collector.start()).category, 'secure_storage_unavailable');
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  const g = await fixture(t); fs.writeFileSync(path.join(g.dataDir, 'sentinel'), 'owned');
  assert.equal((await g.collector.start()).category, 'directory_unavailable');
  assert.equal(fs.readFileSync(path.join(g.dataDir, 'sentinel'), 'utf8'), 'owned');
});

test('real HMAC pairing, real persisted row and independently decoded ACK remain partial evidence without client endpoints', async t => {
  // Inspect original TCP bytes immediately before and after the collector's
  // early observer, before ws installs/runs the product's own frame receiver.
  const originalEmit = http.Server.prototype.emit;
  const byteChecks = [];
  http.Server.prototype.emit = function (type, ...args) {
    const result = Reflect.apply(originalEmit, this, [type, ...args]);
    if (type === 'connection') {
      const socket = args[0]; let original;
      socket.prependListener('data', bytes => { original = Buffer.from(bytes); });
      socket.on('data', bytes => { byteChecks.push(!!original && bytes.equals(original)); });
    }
    return result;
  };
  t.after(() => { http.Server.prototype.emit = originalEmit; });
  const f = await start(t); const c = await connect(t, f);
  c.socket.send(JSON.stringify(event()));
  const ack = await c.next(); assert.equal(ack.type, 'scope.event.ack'); assert.equal(ack.disposition, 'committed_current');
  const result = f.collector.snapshot();
  assert.equal(result.events.length, 1); const captured = result.events[0];
  assert.equal(captured.connectionOrdinal, 1); assert.equal(captured.eventOrdinal, 1);
  assert.equal(captured.category, 'order_unverified'); assert.equal(captured.ackMatched, true); assert.equal(captured.storeMatched, true);
  assert.ok(captured.durableRead); assert.ok(captured.ackSent); assert.equal(captured.orderProven, false);
  assert.equal(captured.pass, false); assert.equal(result.formalAcceptance, false); assert.equal(result.independentScopeVerified, false);
  assert.equal(captured.storeReadBeforeAckWrite, true);
  assert.equal(captured.scopeMatched, true); assert.equal(captured.connectionMatched, true);
  assert.equal(captured.currentAckProofPresent, true);
  const exported = JSON.stringify(result);
  for (const secret of ['PRIVATE_SENTINEL', 'synthetic-event', 'synthetic-run', 'synthetic-session', 'synthetic-conversation', 'conversationTitle', 'requestPreview', 'proof', f.dataDir]) assert.equal(exported.includes(secret), false, secret);
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'sessions.json'), 'utf8').includes('PRIVATE_SENTINEL_TITLE'), true);
  result.events[0].ackSent[0] = -999; result.events.length = 0;
  assert.equal(f.collector.snapshot().events.length, 1); assert.ok(f.collector.snapshot().events[0].ackSent[0] >= 0);
  c.socket.send(JSON.stringify(event(2))); assert.equal((await c.next()).type, 'scope.event.ack');
  assert.deepEqual(f.collector.snapshot().events.map(e => e.eventOrdinal), [1, 2]);
  assert.ok(byteChecks.length >= 5); assert.ok(byteChecks.every(Boolean), 'independent Receiver must not modify original incoming bytes');
});

test('ping calibration is authenticated socket-local; repeated at invalidates both exchanges', async t => {
  const f = await start(t); const c = await connect(t, f);
  c.socket.send(JSON.stringify({ type: 'ping', at: 12345 })); assert.equal((await c.next()).type, 'pong');
  let s = f.collector.snapshot(); assert.equal(s.pings[0].unique, true); assert.ok(s.pings[0].received); assert.ok(s.pings[0].pongSent);
  c.socket.send(JSON.stringify({ type: 'ping', at: 12345 })); await c.next();
  s = f.collector.snapshot(); assert.deepEqual(s.pings.map(p => p.category), ['ambiguous', 'ambiguous']);
  assert.ok(s.pings.every(p => !p.unique && p.missing));
});

test('exact origin protection and unauthenticated scope frames do not produce positive evidence', async t => {
  const f = await start(t);
  const rejected = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: 'https://example.invalid' });
  rejected.on('error', () => {}); t.after(() => rejected.terminate());
  const code = await new Promise((resolve, reject) => { rejected.once('error', reject);
    rejected.on('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); }); });
  assert.equal(code, 403);
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: `chrome-extension://${EXTENSION}` });
  socket.on('error', () => {}); const next = messages(socket); t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); socket.send(JSON.stringify(event()));
  assert.equal((await next()).code, 'authentication_required');
  assert.equal(f.collector.snapshot().events[0].storeMatched, false); assert.equal(f.collector.snapshot().events[0].pass, false);
});

test('replay cannot become a current proof', async t => {
  const f = await start(t); const c = await connect(t, f);
  c.socket.send(JSON.stringify(event(1, { replay: true }))); await c.next();
  assert.equal(f.collector.snapshot().events[0].category, 'noncurrent_ack');
  assert.equal(f.collector.snapshot().events[0].storeMatched, false);
});

test('bounded entries, monotonic discontinuity and expiry stay unknown; dispose releases the port', async t => {
  let clock = 100; const f = await start(t, { now: () => clock, maxEntries: 1 }); const c = await connect(t, f);
  c.socket.send(JSON.stringify({ type: 'ping', at: 1 })); await c.next();
  c.socket.send(JSON.stringify({ type: 'ping', at: 2 })); await c.next();
  assert.equal(f.collector.snapshot().category, 'overflow'); assert.equal(f.collector.snapshot().pings.length, 1);
  await f.collector.dispose(); assert.equal(f.collector.snapshot().status, 'disposed');
  const g = await start(t, { now: () => clock, maxDurationMs: 10 });
  clock = 99; assert.equal(g.collector.snapshot().category, 'clock_discontinuity'); await g.collector.dispose();
  clock = 100; const h = await start(t, { now: () => clock, maxDurationMs: 10 });
  await connect(t, h);
  clock = 111; assert.equal(h.collector.snapshot().category, 'expired');
});

test('capture budget starts at first authenticated ready write-end; manual wait and reconnect never shift source origin or renew it', async t => {
  let clock = 100;
  const f = await start(t, { now: () => clock, maxDurationMs: 10 });
  assert.deepEqual(f.collector.snapshot().capture, { phase: 'waiting', startedAt: null, maxDurationMs: 10,
    maxEntries: 1024, elapsedMs: null, remainingMs: null, lastRecordAt: null });
  clock = 1000100;
  assert.equal(f.collector.snapshot().status, 'running');
  assert.equal(f.collector.snapshot().capture.phase, 'waiting');
  const c = await connect(t, f);
  let s = f.collector.snapshot();
  assert.deepEqual(s.capture, { phase: 'recording', startedAt: 1000000, maxDurationMs: 10,
    maxEntries: 1024, elapsedMs: 0, remainingMs: 10, lastRecordAt: null });
  clock += 3;
  c.socket.send(JSON.stringify({ type: 'ping', at: 100 })); assert.equal((await c.next()).type, 'pong');
  s = f.collector.snapshot();
  assert.deepEqual(s.pings[0].received, [1000003, 1000003]);
  assert.equal(s.capture.lastRecordAt, 1000003); assert.equal(s.capture.elapsedMs, 3);
  assert.equal(s.capture.remainingMs, 7);
  s.capture.startedAt = -1; s.capture.lastRecordAt = -1;
  clock += 2; await connect(t, f);
  assert.equal(f.collector.snapshot().capture.startedAt, 1000000);
  assert.equal(f.collector.snapshot().capture.lastRecordAt, 1000003);
  clock += 5;
  assert.equal(f.collector.snapshot().capture.phase, 'recording');
  assert.equal(f.collector.snapshot().capture.elapsedMs, 10);
  clock += 1; s = f.collector.snapshot();
  assert.equal(s.status, 'unknown'); assert.equal(s.category, 'expired');
  assert.deepEqual(s.capture, { phase: 'unknown', startedAt: 1000000, maxDurationMs: 10,
    maxEntries: 1024, elapsedMs: null, remainingMs: 0, lastRecordAt: 1000003 });
  assert.equal(f.collector.beginPairing().ok, false);
});

test('pre-pair TCP connection cap drop is overflow rather than extending waiting indefinitely', async t => {
  const f = await start(t);
  for (let index = 0; index < 16; index++) {
    const socket = net.createConnection({ host: '127.0.0.1', port: f.port });
    socket.on('error', () => {}); t.after(() => socket.destroy());
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  }
  await until(() => f.collector.snapshot().counts.activeConnections === 16);
  const second = net.createConnection({ host: '127.0.0.1', port: f.port });
  second.on('error', () => {}); t.after(() => second.destroy());
  await new Promise(resolve => second.once('close', resolve));
  const s = f.collector.snapshot();
  assert.equal(s.category, 'overflow'); assert.equal(s.status, 'unknown');
  assert.equal(s.capture.phase, 'unknown'); assert.equal(s.capture.startedAt, null);
  assert.equal(s.counts.connections, 16); assert.equal(s.counts.activeConnections, 16);
  assert.equal(s.limits.maxActiveConnections, 16); assert.equal(s.capture.lastRecordAt, null);
  assert.equal(f.collector.beginPairing().ok, false);
});

test('twenty-four sequential unauthenticated closes release active slots and still allow real HMAC pairing', async t => {
  const f = await start(t);
  for (let index = 0; index < 24; index++) {
    const socket = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: `chrome-extension://${EXTENSION}` });
    socket.on('error', () => {}); t.after(() => socket.terminate());
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const closed = new Promise(resolve => socket.once('close', resolve)); socket.close(); await closed;
    await until(() => f.collector.snapshot().counts.activeConnections === 0);
  }
  let s = f.collector.snapshot();
  assert.equal(s.status, 'running'); assert.equal(s.capture.phase, 'waiting');
  assert.equal(s.counts.connections, 24); assert.equal(s.counts.activeConnections, 0);
  assert.equal(s.events.length, 0); assert.equal(s.pings.length, 0);
  assert.deepEqual(s.limits, { maxActiveConnections: 16, maxEntries: 1024, maxBytes: 8 * 1024 * 1024,
    maxDurationMs: 120000, timeoutMs: 10000, maxFrameBytes: 16384, maxStoreBytes: 8 * 1024 * 1024 });
  s.limits.maxActiveConnections = 999;
  const c = await connect(t, f);
  c.socket.send(JSON.stringify(event())); assert.equal((await c.next()).type, 'scope.event.ack');
  c.socket.send(JSON.stringify({ type: 'ping', at: 314 })); assert.equal((await c.next()).type, 'pong');
  s = f.collector.snapshot();
  assert.equal(s.counts.connections, 25); assert.equal(s.counts.activeConnections, 1);
  assert.equal(s.limits.maxActiveConnections, 16); assert.equal(s.capture.phase, 'recording');
  assert.equal(s.events[0].connectionOrdinal, 25); assert.equal(s.events[0].eventOrdinal, 1);
  assert.equal(s.events[0].storeMatched, true); assert.equal(s.events[0].ackMatched, true);
  assert.equal(s.events[0].category, 'order_unverified'); assert.equal(s.pings[0].unique, true);
  assert.equal(s.pass, false); assert.equal(s.formalAcceptance, false);
});

test('waiting byte limit still fails closed even though historical connections no longer consume slots', async t => {
  const f = await start(t, { maxBytes: 64 });
  const socket = net.createConnection({ host: '127.0.0.1', port: f.port });
  socket.on('error', () => {}); socket.resume(); t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nX-Bounded: ${'x'.repeat(256)}\r\nConnection: close\r\n\r\n`);
  await closed;
  const s = f.collector.snapshot();
  assert.ok(s.counts.bytes > s.limits.maxBytes); assert.equal(s.limits.maxBytes, 64);
  assert.equal(s.category, 'overflow'); assert.equal(s.status, 'unknown');
  assert.equal(s.capture.phase, 'unknown'); assert.equal(s.capture.startedAt, null);
  assert.equal(f.collector.beginPairing().ok, false);
});

test('released authenticated sockets retain reconnect calibration uncertainty without ordinal reuse', async t => {
  const f = await start(t); const first = await connect(t, f);
  first.socket.send(JSON.stringify({ type: 'ping', at: 51 })); await first.next();
  assert.equal(f.collector.snapshot().pings[0].unique, true);
  const second = await connect(t, f);
  await until(() => f.collector.snapshot().counts.activeConnections === 1);
  second.socket.send(JSON.stringify({ type: 'ping', at: 52 })); await second.next();
  const s = f.collector.snapshot();
  assert.equal(s.counts.connections, 2); assert.equal(s.counts.activeConnections, 1);
  assert.deepEqual(s.pings.map(p => p.connectionOrdinal), [1, 2]);
  assert.ok(s.pings.every(p => !p.unique && p.missing));
  assert.equal(s.pings[1].category, 'clock_discontinuity');
  assert.equal(s.status, 'running'); assert.equal(s.formalAcceptance, false);
});

test('normative composite row and receipt IDs at 256/257/393/394 characters match real persisted events without appearing in exports', async t => {
  for (const lengths of [[82, 82, 82], [83, 82, 82], [128, 128, 127], [128, 128, 128]]) {
    const [clientSize, runSize, sessionSize] = lengths;
    const clientId = 'C'.repeat(clientSize), browserRunId = 'R'.repeat(runSize), sessionId = 'S'.repeat(sessionSize);
    const composite = `browser:${clientId}:${browserRunId}:${sessionId}`;
    assert.equal(composite.length, 10 + lengths.reduce((sum, length) => sum + length, 0));
    const f = await start(t); const c = await connect(t, f, undefined, { clientId, browserRunId });
    const common = { browserRunId, sessionId, conversationRef: `/c/${'c'.repeat(128)}` };
    c.socket.send(JSON.stringify(event(1, common)));
    assert.equal((await c.next()).disposition, 'committed_current');
    c.socket.send(JSON.stringify(event(2, { ...common, kind: 'terminal', phase: 'settled', turnId: 'synthetic-terminal',
      generation: 1, outcome: 'unverified' })));
    assert.equal((await c.next()).disposition, 'committed_current');
    const persisted = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'sessions.json'), 'utf8'));
    assert.equal(persisted.sessions[0].id, composite); assert.equal(persisted.receipts[0].id, composite);
    const snapshot = f.collector.snapshot();
    assert.equal(snapshot.events.length, 2);
    for (const captured of snapshot.events) {
      assert.equal(captured.category, 'order_unverified', `composite length ${composite.length}`);
      assert.equal(captured.storeMatched, true); assert.equal(captured.ackMatched, true);
      assert.ok(captured.durableRead); assert.ok(captured.ackSent);
      assert.equal(captured.pass, false); assert.equal(captured.formalAcceptance, false);
    }
    const exported = JSON.stringify(snapshot);
    for (const privateValue of [composite, clientId, browserRunId, sessionId, common.conversationRef, 'PRIVATE_SENTINEL'])
      assert.equal(exported.includes(privateValue), false);
    await f.collector.dispose();
  }
});

test('a 129-character wire identity cannot obtain authentication or widen the composite-store projection', async t => {
  const f = await start(t); const pairing = f.collector.beginPairing(); assert.equal(pairing.ok, true);
  const code = JSON.parse(Buffer.from(pairing.code.slice(6), 'base64url'));
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: `chrome-extension://${EXTENSION}` });
  const next = messages(socket); socket.on('error', () => {}); t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', v: 1, mode: 'pair', clientId: 'C'.repeat(129), browserRunId: 'R'.repeat(128),
    instanceId: code.instanceId, credentialId: code.pairingId, clientNonce: Buffer.alloc(32, 7).toString('base64url') }));
  assert.equal((await next()).code, 'invalid_hello');
  const snapshot = f.collector.snapshot();
  assert.equal(snapshot.capture.startedAt, null); assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.formalAcceptance, false);
});

test('throwing or invalid clocks fail closed before listening', async t => {
  for (const now of [() => { throw new Error('PRIVATE_CLOCK'); }, () => NaN, () => -1]) {
    const f = await fixture(t, { now }); assert.equal((await f.collector.start()).category, 'clock_invalid');
    assert.equal(JSON.stringify(f.collector.snapshot()).includes('PRIVATE_CLOCK'), false);
  }
});

test('A1 self-reported identity and fixed pairing reasons survive expiry without renewing the run', async t => {
  let clock = 100;
  const kit = 'a'.repeat(64), bundle = 'b'.repeat(64);
  const f = await fixture(t, { now: () => clock, maxDurationMs: 10,
    kitSourceFingerprint: kit, measurementBuildFingerprint: bundle });
  const before = f.collector.snapshot();
  assert.deepEqual(before.pairing, { canIssue: false, canCopy: false, reason: 'not_started' });
  assert.equal(f.collector.beginPairing().reason, 'not_started');
  assert.equal(f.collector.getProductBridge(), null); assert.equal(f.collector.getProductPort(), null);
  const identity = before.runtime;
  assert.equal(identity.componentFingerprint, crypto.createHash('sha256').update(
    fs.readFileSync(require.resolve('../scripts/native-measurement-collector'))).digest('hex'));
  assert.equal(identity.kitSourceFingerprint, kit); assert.equal(identity.buildFingerprint, bundle);
  assert.equal(identity.loadedArtifactVerified, false); assert.equal(identity.collectorSelfReported, true);
  assert.ok(Number.isSafeInteger(identity.runGeneration));
  const started = await f.collector.start(); assert.equal(started.ok, true);
  assert.ok(f.collector.getProductBridge()); assert.equal(f.collector.getProductPort(), started.port);
  assert.equal(f.collector.snapshot().pairing.reason, 'none');
  clock += 100000;
  assert.equal(f.collector.snapshot().capture.remainingMs, null);
  await connect(t, { ...f, port: started.port });
  assert.equal(f.collector.snapshot().capture.remainingMs, 10);
  clock += 11;
  const expired = f.collector.snapshot();
  assert.equal(expired.capture.remainingMs, 0); assert.equal(expired.capture.phase, 'unknown');
  assert.deepEqual(expired.pairing, { canIssue: false, canCopy: false, reason: 'expired' });
  assert.equal(f.collector.beginPairing().reason, 'expired');
  assert.deepEqual(expired.runtime, identity);
  expired.runtime.runGeneration = -1;
  assert.deepEqual(f.collector.snapshot().runtime, identity);
  await f.collector.dispose();
  assert.equal(f.collector.getProductBridge(), null); assert.equal(f.collector.getProductPort(), null);
  const g = await fixture(t, { kitSourceFingerprint: 'PRIVATE_SENTINEL', measurementBuildFingerprint: kit.toUpperCase() });
  assert.equal(g.collector.snapshot().runtime.kitSourceFingerprint, null);
  assert.equal(g.collector.snapshot().runtime.buildFingerprint, null);
  assert.equal(JSON.stringify(g.collector.snapshot()).includes('PRIVATE_SENTINEL'), false);
});

test('dev onChange runs after independent store reread and throwing UI cannot change durable ACK', async t => {
  let f, calls = 0, sawReadBeforeCallback = false;
  f = await start(t, { onChange() {
    calls++;
    if (f?.collector.snapshot().events.some(e => e.durableRead)) sawReadBeforeCallback = true;
    throw new Error('PRIVATE_UI_CALLBACK');
  } });
  const c = await connect(t, f); c.socket.send(JSON.stringify(event()));
  assert.equal((await c.next()).disposition, 'committed_current');
  const snapshot = f.collector.snapshot();
  assert.ok(calls > 0); assert.equal(sawReadBeforeCallback, true);
  assert.equal(snapshot.events[0].storeMatched, true); assert.equal(snapshot.events[0].storeReadBeforeAckWrite, true);
  assert.equal(snapshot.status, 'running'); assert.equal(snapshot.formalAcceptance, false);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_UI_CALLBACK'), false);
});

test('collector UI uses only self-reported identity and fixed reasons, with expired controls disabled', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false,
    handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } }); return elements.get(id); };
  let state = { ok: true, runtime: {}, capture: { phase: 'waiting', remainingMs: null },
    pairing: { canIssue: true, canCopy: true, reason: 'none' } };
  let tick, opens = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/native-measurement-renderer.js'), 'utf8'), {
    document: { getElementById: element }, window: { moriMeasurement: {
      status: async () => state,
      pair: async () => ({ ok: false, reason: 'PRIVATE_SENTINEL_REASON' }),
      copyPair: async () => ({ ok: false, reason: 'clipboard_unavailable' }),
      openProductUI: async () => { opens++; return { ok: true }; },
    } }, setInterval(fn) { tick = fn; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(element('fingerprint').textContent, /確認不能/);
  assert.equal(element('remaining').textContent, '認証後から開始');
  await element('pair').handlers.click();
  assert.equal(element('code').textContent.includes('PRIVATE_SENTINEL'), false);
  await element('copy').handlers.click(); assert.match(element('code').textContent, /クリップボード/);
  await element('open-product-ui').handlers.click(); assert.equal(opens, 1);
  state = { ok: false, category: 'expired', runtime: { runGeneration: 123, componentFingerprint: 'c'.repeat(64) },
    capture: { phase: 'unknown', remainingMs: 0 }, pairing: { canIssue: false, canCopy: false, reason: 'expired' } };
  await tick();
  assert.equal(element('run').textContent, '123'); assert.equal(element('fingerprint').textContent, 'c'.repeat(64));
  assert.equal(element('remaining').textContent, '0 秒'); assert.equal(element('pair').disabled, true);
  assert.equal(element('copy').disabled, true); assert.match(element('pair-reason').textContent, /計測時間の上限/);
});
