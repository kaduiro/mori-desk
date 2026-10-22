const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const restartHealth = require("../extensions/browser-bridge/restart-health");
const { createBrowserBridge } = require("../src/browser-bridge-server");
const { EXTENSION_ID, mac, verifyMac } = require("../src/browser-bridge-protocol");

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`test-vault:${text}`),
  decryptString: (buffer) => buffer.toString("utf8").slice(11),
};

function healthFrame(patch = {}) {
  return { type: "client.health", v: 1, schema: 1, browserRunId: "run-1", workerEpoch: "health-worker",
    sequence: 1, extensionVersion: "0.1.8", observerVersion: "0.1.8", buildId: "e".repeat(64), observerContract: 1,
    providers: restartHealth.unknownProviders(),
    delivery: { state: "current", remainingReplay: 0, livePending: 0, reserveUsed: 0 }, ...patch };
}

test("health has a 45-second receipt lifetime and cannot refresh a row or erase unread data", async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now,
    buildInfo: { desktopVersion: "0.1.3-preview.1", buildId: "e".repeat(64), observerContract: 1 } });
  const client = await f.pair();
  assert.deepEqual(client.ready.capabilities, ["restart-health-v1"]);
  assert.equal(f.bridge.getStatus().clientHealth[0].state, "unknown");
  await f.deliver(client, f.terminal());
  const before = f.bridge.getSnapshot()[0];
  const bytes = fs.readFileSync(path.join(f.dataDir, "sessions.json"));
  client.send(healthFrame()); client.send({ type: "ping", at: now }); await client.take("pong");
  assert.equal(f.bridge.getStatus().clientHealth[0].state, "current");
  assert.equal(f.bridge.getSnapshot()[0].lastObservationAt, before.lastObservationAt);
  assert.equal(f.bridge.getSnapshot()[0].unreadCount, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir, "sessions.json")), bytes);
  now += 45001;
  client.send({ type: "ping", at: now }); await client.take("pong");
  assert.equal(f.bridge.getStatus().connectedClients.length, 1);
  assert.equal(f.bridge.getStatus().clientHealth[0].state, "stale");
  assert.equal(f.bridge.getStatus().clientHealth[0].health, null);
  client.send(healthFrame({ sequence: 2 })); client.send({ type: "ping", at: now }); await client.take("pong");
  assert.equal(f.bridge.getStatus().clientHealth[0].state, "current");
  const replacement = await f.pair("client-1", "run-1");
  assert.equal(f.bridge.getStatus().clientHealth[0].state, "unknown", "health belongs to the old connection, not the browser id");
  replacement.send(healthFrame({ workerEpoch: "new-worker" }));
  replacement.send({ type: "ping", at: now }); await replacement.take("pong");
  assert.equal(f.bridge.getStatus().clientHealth[0].state, "current");
});

test("health identity, worker epoch and sequence cannot be reassigned inside one authenticated socket", async t => {
  const buildInfo = { desktopVersion: "0.1.3-preview.1", buildId: "e".repeat(64), observerContract: 1 };
  for (const [patch, code] of [[{ browserRunId: "other-run" }, "health_identity_mismatch"],
    [{ sequence: 1 }, "health_sequence"], [{ workerEpoch: "other-worker", sequence: 2 }, "health_sequence"]]) {
    const f = await fixture(t, { buildInfo });
    const client = await f.pair();
    client.send(healthFrame()); client.send({ type: "ping", at: Date.now() }); await client.take("pong");
    client.send(healthFrame(patch));
    assert.equal((await client.take("error")).code, code);
  }
});

function channel(socket) {
  const queue = [];
  const waits = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const index = waits.findIndex((wait) => wait.type === message.type);
    if (index >= 0) {
      const [wait] = waits.splice(index, 1);
      clearTimeout(wait.timer); wait.resolve(message);
    } else queue.push(message);
  });
  return {
    socket,
    send(message) { socket.send(JSON.stringify(message)); },
    take(type) {
      const index = queue.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const wait = { type, resolve, timer: null };
        wait.timer = setTimeout(() => { waits.splice(waits.indexOf(wait), 1); reject(new Error(`Timed out waiting for ${type}`)); }, 3000);
        waits.push(wait);
      });
    },
    queued(type) { return queue.filter((message) => message.type === type); },
  };
}

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-browser-ws-"));
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const bridge = createBrowserBridge({ dataDir, safeStorage, ...options });
  bridge.attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const opened = [];
  t.after(async () => {
    opened.forEach((socket) => socket.terminate());
    bridge.dispose();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/browser/v1`, { origin: `chrome-extension://${EXTENSION_ID}` });
    opened.push(socket);
    const client = channel(socket);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return client;
  }
  async function pair(clientId = "client-1", browserRunId = "run-1") {
    const pairing = JSON.parse(Buffer.from(bridge.beginPairing(port).code.slice(6), "base64url").toString("utf8"));
    const client = await connect();
    client.send({ type: "hello", v: 1, mode: "pair", clientId, browserRunId, instanceId: pairing.instanceId,
      credentialId: pairing.pairingId, clientNonce: crypto.randomBytes(32).toString("base64url") });
    const context = await client.take("challenge");
    assert.equal(context.port, port);
    assert.equal(verifyMac(context.proof, pairing.secret, "server-proof", context), true);
    client.send({ type: "authenticate", proof: mac(pairing.secret, "client-proof", context) });
    await client.take("pair.ready");
    const key = mac(pairing.secret, "credential", context);
    client.send({ type: "pair.confirm", proof: mac(key, "pair-confirm", context) });
    const ready = await client.take("ready");
    return { ...client, key, clientId, browserRunId, ready, instanceId: pairing.instanceId };
  }
  function event(overrides = {}) {
    return { type: "event", v: 1, eventId: `event-${overrides.sequence || 1}`, browserRunId: "run-1", sessionId: "session-1",
      sequence: 1, kind: "observation", provider: "chatgpt", tabId: 1, pageInstanceId: "document-1", routeRevision: 0,
      conversationRef: "/c/id", turnId: "turn-1", generation: 1, phase: "running", outcome: null,
      observation: "fresh", observedAt: Date.now(), replay: false, ...overrides };
  }
  function terminal(overrides = {}) { return event({ sequence: 2, kind: "terminal", phase: "settled", outcome: "completed", ...overrides }); }
  async function deliver(client, message) { client.send(message); return client.take("event.ack"); }
  function focusResponse(request, patch = {}) {
    const { requestId, browserRunId, sessionId, pageInstanceId, routeRevision, conversationRef } = request;
    return { type: "focus.result", requestId, browserRunId, sessionId, pageInstanceId, routeRevision, conversationRef, ok: true, ...patch };
  }
  return { bridge, server, port, dataDir, opened, connect, pair, event, terminal, deliver, focusResponse };
}

test("real loopback WebSocket pairs, persists completion, and returns to the exact tab", async (t) => {
  const f = await fixture(t);
  const client = await f.pair();
  await f.deliver(client, f.event());
  await f.deliver(client, f.terminal());
  const row = f.bridge.getSnapshot()[0];
  const disk = JSON.parse(fs.readFileSync(path.join(f.dataDir, "sessions.json"), "utf8"));
  assert.equal(disk.receipts.length, 1); // event.ack was received only after durable receipt.
  const focused = f.bridge.focus(row.id, row.noticeSequence);
  const request = await client.take("focus.request");
  assert.equal(request.tabId, 1);
  client.send(f.focusResponse(request));
  assert.equal((await focused).ok, true);
  assert.equal(f.bridge.getSnapshot()[0].requiresCompletionAck, false);
});

test("authenticated short metadata persists before ACK and stays out of navigation requests", async (t) => {
  const f = await fixture(t);
  const client = await f.pair();
  const event = f.terminal({ conversationTitle: "会話を識別するタイトル", requestPreview: "提出した依頼の短い抜粋" });
  await f.deliver(client, event);
  const row = f.bridge.getSnapshot()[0];
  const disk = JSON.parse(fs.readFileSync(path.join(f.dataDir, "sessions.json"), "utf8"));
  assert.equal(disk.sessions[0].conversationTitle, event.conversationTitle);
  assert.equal(disk.sessions[0].requestPreview, event.requestPreview);
  assert.equal(disk.receipts.length, 1);
  assert.equal(row.displayTitle, event.conversationTitle);
  assert.equal(row.isCurrent, true);
  assert.equal(row.isHistory, false);
  const focused = f.bridge.focus(row.id, row.noticeSequence);
  const request = await client.take("focus.request");
  assert.equal(request.pageInstanceId, row.pageInstanceId);
  assert.equal(request.conversationRef, row.conversationRef);
  assert.equal(Object.hasOwn(request, "conversationTitle"), false);
  assert.equal(Object.hasOwn(request, "requestPreview"), false);
  client.send(f.focusResponse(request));
  assert.equal((await focused).ok, true);
  assert.equal(f.bridge.getSnapshot()[0].requiresCompletionAck, false);
});

test("a newer completion racing the focus result remains unread", async (t) => {
  const f = await fixture(t);
  const client = await f.pair();
  await f.deliver(client, f.terminal());
  const row = f.bridge.getSnapshot()[0];
  const focused = f.bridge.focus(row.id, row.noticeSequence);
  const request = await client.take("focus.request");
  await f.deliver(client, f.terminal({ sequence: 4, generation: 2, turnId: "turn-2" }));
  client.send(f.focusResponse(request));
  assert.equal((await focused).ok, true);
  assert.equal(f.bridge.getSnapshot()[0].unreadCount, 1);
  assert.equal(f.bridge.getSnapshot()[0].pendingNotice.turnId, "turn-2");
});

test("page change during focus fails without clearing a receipt", async (t) => {
  const f = await fixture(t);
  const client = await f.pair();
  await f.deliver(client, f.terminal());
  const row = f.bridge.getSnapshot()[0];
  const focused = f.bridge.focus(row.id, row.noticeSequence);
  const request = await client.take("focus.request");
  await f.deliver(client, f.event({ sequence: 3, pageInstanceId: "document-2", generation: 2, turnId: "turn-2" }));
  client.send(f.focusResponse(request));
  assert.equal((await focused).ok, false);
  assert.equal(f.bridge.getSnapshot()[0].requiresCompletionAck, true);
});

test("null captured notice never acknowledges a completion that arrives during focus", async (t) => {
  const f = await fixture(t);
  const client = await f.pair();
  await f.deliver(client, f.event());
  const row = f.bridge.getSnapshot()[0];
  const focused = f.bridge.focus(row.id, null);
  const request = await client.take("focus.request");
  await f.deliver(client, f.terminal());
  client.send(f.focusResponse(request));
  assert.equal((await focused).ok, true);
  assert.equal(f.bridge.getSnapshot()[0].requiresCompletionAck, true);
});

test("missing or foreign Origin is rejected before WebSocket authentication", async (t) => {
  const f = await fixture(t);
  for (const origin of [undefined, "https://chatgpt.com", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
    const status = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, origin ? { origin } : {});
      f.opened.push(socket);
      socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
      socket.on("open", () => reject(new Error("unsafe Origin accepted")));
      socket.on("error", () => {});
    });
    assert.equal(status, 403);
  }
});

test("state events without a proven client never create a HUD session", async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  client.send(f.event());
  assert.equal((await client.take("error")).code, "authentication_required");
  assert.equal(f.bridge.getSnapshot().length, 0);
});

test("disk failure sends an explicit error and no terminal ACK", async (t) => {
  let fail = false;
  const injectedFs = { ...fs, renameSync(from, to) {
    if (fail && to.endsWith("sessions.json")) throw new Error("injected disk failure");
    fs.renameSync(from, to);
  } };
  const f = await fixture(t, { fs: injectedFs });
  const client = await f.pair();
  await f.deliver(client, f.event());
  fail = true;
  client.send(f.terminal());
  assert.equal((await client.take("error")).code, "session_store_write_failed");
  assert.equal(client.queued("event.ack").length, 0);
  assert.equal(f.bridge.getSnapshot()[0].unreadCount, 0);
});

test("profile revocation closes its upgraded socket and removes its local rows", async (t) => {
  const f = await fixture(t);
  const client = await f.pair();
  await f.deliver(client, f.terminal());
  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  assert.equal((await f.bridge.revoke("client-1")).ok, true);
  await closed;
  assert.equal(f.bridge.getSnapshot().length, 0);
  assert.equal(f.bridge.getStatus().pairedClients.length, 0);
});
