"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const current = require("../src/browser-bridge-server");
const currentTransport = require("../extensions/browser-bridge/transport");
const legacy = require("./fixtures/restart-compat-v017/src/browser-bridge-server");
const legacyTransport = require("./fixtures/restart-compat-v017/extensions/browser-bridge/transport");
const { EXTENSION_ID } = require("../src/browser-bridge-protocol");
const healthApi = require("../extensions/browser-bridge/restart-health");
const frozenRoot = path.join(__dirname, "fixtures/restart-compat-v017");
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`fixture:${value}`), decryptString: value => value.toString().slice(8) };

test("the old peer bytes remain the reviewed product's recorded Git blobs", () => {
  const provenance = require("./fixtures/restart-compat-v017/provenance.json");
  assert.equal(provenance.reviewedProductCommit, "c56d1593676d4ff5b53996afac1e1c12da0a8e3d");
  for (const file of provenance.files) {
    const bytes = fs.readFileSync(path.join(frozenRoot, file.path));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), file.reviewedGitBlob);
  }
});

async function bind(server) {
  for (const port of [...currentTransport.PORTS].reverse()) {
    const ok = await new Promise((resolve, reject) => {
      const error = cause => { server.removeListener("listening", listening); cause.code === "EADDRINUSE" ? resolve(false) : reject(cause); };
      const listening = () => { server.removeListener("error", error); resolve(true); };
      server.once("error", error); server.once("listening", listening); server.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  throw new Error("No free Mori compatibility test port");
}

for (const [serverName, serverApi] of [["old", legacy], ["new", current]]) {
  for (const [extensionName, extensionApi] of [["old", legacyTransport], ["new", currentTransport]]) {
    test(`real wire compatibility: ${serverName} desktop / ${extensionName} extension`, async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-restart-compat-"));
      const bridge = serverApi.createBrowserBridge({ dataDir: dir, safeStorage,
        buildInfo: { desktopVersion: "0.1.3-preview.1", buildId: "c".repeat(64), observerContract: 1 } });
      const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
      bridge.attach(server);
      const sockets = [], sent = [], received = [];
      let credential = null;
      class Wire extends WebSocket {
        constructor(url) {
          super(url, { origin: `chrome-extension://${EXTENSION_ID}` }); sockets.push(this);
          this.on("message", bytes => received.push(JSON.parse(bytes.toString())));
        }
        send(value, ...args) { sent.push(JSON.parse(value)); return super.send(value, ...args); }
      }
      const transport = new extensionApi.Transport({ clientId: "compat-client", browserRunId: "compat-run",
        cryptoApi: crypto.webcrypto, WebSocketClass: Wire,
        getCredential: () => credential, saveCredential: async value => { credential = value; } });
      t.after(async () => {
        transport.enabled = false; transport.disconnect(); sockets.forEach(socket => socket.terminate());
        bridge.dispose(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true });
      });
      const port = await bind(server);
      await transport.pair(bridge.beginPairing(port).code);
      assert.equal(transport.isReady(), true);
      const report = { type: "client.health", v: 1, schema: 1, browserRunId: "compat-run", workerEpoch: "compat-worker",
        sequence: 1, extensionVersion: "0.1.8", observerVersion: "0.1.8", buildId: "d".repeat(64), observerContract: 1,
        providers: healthApi.unknownProviders(), delivery: { state: "current", remainingReplay: 0, livePending: 0, reserveUsed: 0 } };
      const allowed = serverName === "new" && extensionName === "new";
      if (transport.sendHealth) assert.equal(transport.sendHealth(report), allowed);
      const event = { type: "event", v: 1, eventId: "compat-terminal", browserRunId: "compat-run", sessionId: "compat-session",
        sequence: 1, kind: "terminal", provider: "chatgpt", tabId: 9, pageInstanceId: "compat-page", routeRevision: 0,
        conversationRef: "/c/compat", turnId: "compat-turn", generation: 1, phase: "settled", outcome: "unverified",
        observation: "fresh", observedAt: Date.now(), replay: false };
      const ack = await transport.sendEvent(event);
      assert.equal(ack.eventId, event.eventId);
      assert.equal(transport.isReady(), true);
      assert.equal(sent.filter(item => item.type === "client.health").length, allowed ? 1 : 0);
      assert.equal(received.some(item => item.type === "error"), false);
      const disk = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
      assert.equal(disk.receipts.length, 1, "each old/new pair must preserve the durable receipt ACK");
      assert.equal(bridge.getSnapshot()[0].unreadCount, 1);
      if (serverName === "new") {
        assert.equal(bridge.getStatus().clientHealth[0].state, allowed ? "current" : "unknown");
        assert.doesNotMatch(JSON.stringify(disk), /client.health|workerEpoch|extensionVersion/);
      }
    });
  }
}
