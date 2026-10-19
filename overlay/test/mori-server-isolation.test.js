"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { WebSocket } = require("ws");
const initServer = require("../src/server");
const { probePort } = require("../hooks/server-config");
const { createBrowserBridge } = require("../src/browser-bridge-server");
const { EXTENSION_ID, mac, verifyMac } = require("../src/browser-bridge-protocol");

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-http-isolation-"));
  const mutations = [];
  const clients = [];
  const bridge = createBrowserBridge({
    dataDir,
    // Test-only key storage. The real application injects Electron safeStorage.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: text => Buffer.from(text),
      decryptString: buffer => buffer.toString("utf8"),
    },
  });
  let server;
  const api = initServer({
    browserOnly: true,
    isWinHost: false,
    createHttpServer: handler => { server = http.createServer(handler); return server; },
    attachBrowserBridge: value => bridge.attach(value),
    // Port 0 is confined to this fixture; production candidates remain 23333–23337.
    getPortCandidates: () => [0],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    readRuntimeIdentity: () => ({ ok: false, reason: "runtime-missing", port: null, ownerPid: null }),
    isAgentEnabled: () => true, // The transport boundary must hold even before agent gates.
    isAgentPermissionsEnabled: () => true,
    sessions: new Map(),
    pendingPermissions: new Map(),
    updateSession: (...args) => mutations.push(["session", ...args]),
    setState: (...args) => mutations.push(["state", ...args]),
    showPermissionBubble: (...args) => mutations.push(["permission", ...args]),
  });
  await api.startHttpServer();
  const port = server.address().port;
  t.after(async () => {
    const closed = new Promise(resolve => server.once("close", resolve));
    clients.forEach(client => client.terminate());
    bridge.dispose();
    api.cleanup();
    await closed;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  function request(method, route, data) {
    return new Promise((resolve, reject) => {
      const text = data ? JSON.stringify(data) : "";
      const request = http.request({ hostname: "127.0.0.1", port, method, path: route,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) } : {},
      }, response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", value => { body += value; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      request.on("error", reject);
      request.end(text);
    });
  }
  return { bridge, api, port, mutations, request, clients };
}

test("browser-only HTTP server is not discovered as a native Clawd receiver", async t => {
  const f = await fixture(t);
  const response = await f.request("GET", "/state");
  assert.equal(response.status, 404);
  assert.equal(response.headers["x-clawd-server"], undefined);
  assert.equal(response.body.includes('"app":"clawd-on-desk"'), false);
  const discovered = await new Promise(resolve => probePort(f.port, 1000, resolve, { sshSecure: false }));
  assert.equal(discovered, false);
});

test("native state, permission, and question POSTs have no accepted marker or state effects in browser mode", async t => {
  const f = await fixture(t);
  for (const route of ["/state", "/permission", "/question"]) {
    const response = await f.request("POST", route, {
      agent_id: "claude-code", session_id: "native-session", state: "working", event: "PreToolUse",
      tool_name: "Bash", tool_input: { command: "native payload must not be acted on" },
    });
    assert.equal(response.status, 404, route);
    assert.equal(response.headers["x-clawd-server"], undefined, route);
  }
  assert.deepEqual(f.mutations, []);
  assert.equal(f.bridge.getSnapshot().length, 0);
});

test("authenticated browser WebSocket upgrades still work on the HTTP-isolated listener", async t => {
  const f = await fixture(t);
  const pairing = JSON.parse(Buffer.from(f.bridge.beginPairing(f.port).code.slice(6), "base64url").toString("utf8"));
  const socket = new WebSocket(`ws://127.0.0.1:${f.port}/browser/v1`, { origin: `chrome-extension://${EXTENSION_ID}` });
  f.clients.push(socket);
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser handshake did not complete")), 3000);
    let context;
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("message", data => {
      try {
        const message = JSON.parse(data.toString("utf8"));
        if (message.type === "challenge") {
          context = message;
          assert.equal(context.port, f.port);
          assert.equal(verifyMac(context.proof, pairing.secret, "server-proof", context), true);
          socket.send(JSON.stringify({ type: "authenticate", proof: mac(pairing.secret, "client-proof", context) }));
        } else if (message.type === "pair.ready") {
          const key = mac(pairing.secret, "credential", context);
          socket.send(JSON.stringify({ type: "pair.confirm", proof: mac(key, "pair-confirm", context) }));
        } else if (message.type === "ready") {
          clearTimeout(timer); resolve(message);
        } else if (message.type === "error") throw new Error(message.code);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  socket.on("open", () => socket.send(JSON.stringify({ type: "hello", v: 1, mode: "pair",
    clientId: "isolated-client", browserRunId: "isolated-run", instanceId: pairing.instanceId,
    credentialId: pairing.pairingId, clientNonce: crypto.randomBytes(32).toString("base64url") })));
  const ready = await completed;
  assert.equal(ready.clientId, "isolated-client");
  assert.equal(f.bridge.getStatus().connectedClients.length, 1);
  assert.deepEqual(f.mutations, []);
});
