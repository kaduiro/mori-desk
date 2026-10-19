const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBrowserBridgeAuth } = require("../src/browser-bridge-auth");
const { mac, verifyMac, validateHello, validateEvent } = require("../src/browser-bridge-protocol");

// This deterministic test double is not a supported production storage backend.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`test-vault:${text}`, "utf8"),
  decryptString: (buffer) => {
    const value = buffer.toString("utf8");
    if (!value.startsWith("test-vault:")) throw new Error("invalid test vault");
    return value.slice(11);
  },
};

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-browser-auth-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = 1000000;
  const auth = createBrowserBridgeAuth({ dataDir, safeStorage, now: () => clock });
  const pairing = JSON.parse(Buffer.from(auth.beginPairing(23334).code.slice(6), "base64url").toString("utf8"));
  const hello = validateHello({ type: "hello", v: 1, mode: "pair", clientId: "client-1", browserRunId: "run-1",
    instanceId: pairing.instanceId, credentialId: pairing.pairingId, clientNonce: crypto.randomBytes(32).toString("base64url") });
  return { auth, dataDir, pairing, hello, now: () => clock, advance(ms) { clock += ms; } };
}

test("mutual authentication binds direction, nonce, instance, server run, and actual port", (t) => {
  const f = fixture(t);
  const handshake = f.auth.challenge(f.hello, 23334);
  assert.equal(verifyMac(handshake.message.proof, f.pairing.secret, "server-proof", handshake.context), true);
  for (const patch of [{ port: 23335 }, { instanceId: "another-instance" }, { serverRunId: "another-run" }, { clientNonce: crypto.randomBytes(32).toString("base64url") }]) {
    assert.equal(verifyMac(handshake.message.proof, f.pairing.secret, "server-proof", { ...handshake.context, ...patch }), false);
  }
  assert.equal(verifyMac(handshake.message.proof, f.pairing.secret, "client-proof", handshake.context), false);
  assert.throws(() => f.auth.authenticate(handshake, handshake.message.proof), { code: "authentication_failed" });
});

test("pairing is activated only after durable pending key and client confirmation", (t) => {
  const f = fixture(t);
  const handshake = f.auth.challenge(f.hello, 23334);
  const response = f.auth.authenticate(handshake, mac(f.pairing.secret, "client-proof", handshake.context));
  assert.equal(response.type, "pair.ready");
  assert.deepEqual(f.auth.getStatus().pairedClients, []);
  const credential = mac(f.pairing.secret, "credential", handshake.context);
  f.auth.confirm(handshake, mac(credential, "pair-confirm", handshake.context));
  assert.equal(f.auth.getStatus().pairedClients[0].clientId, "client-1");
  assert.throws(() => f.auth.challenge(f.hello, 23334), { code: "pairing_expired" });
});

test("saved pending credential resumes after app restart when the final pairing exchange was lost", (t) => {
  const f = fixture(t);
  const handshake = f.auth.challenge(f.hello, 23334);
  f.auth.authenticate(handshake, mac(f.pairing.secret, "client-proof", handshake.context));
  const credential = mac(f.pairing.secret, "credential", handshake.context);
  const restarted = createBrowserBridgeAuth({ dataDir: f.dataDir, safeStorage, now: f.now });
  const resumed = restarted.challenge(validateHello({ ...f.hello, mode: "resume", credentialId: "client-1" }), 23335);
  assert.equal(verifyMac(resumed.message.proof, credential, "server-proof", resumed.context), true);
  assert.equal(restarted.authenticate(resumed, mac(credential, "client-proof", resumed.context)).type, "ready");
  assert.equal(restarted.getStatus().pairedClients.length, 1);
  assert.notEqual(restarted.serverRunId, f.auth.serverRunId);
});

test("expired pairing code and wrong pairing port are rejected", (t) => {
  const f = fixture(t);
  assert.throws(() => f.auth.challenge(f.hello, 23335), { code: "pairing_expired" });
  f.advance(120001);
  assert.throws(() => f.auth.challenge(f.hello, 23334), { code: "pairing_expired" });
});

test("OS key storage unavailable and Linux basic_text both fail closed", (t) => {
  const f = fixture(t);
  for (const unavailable of [
    { ...safeStorage, isEncryptionAvailable: () => false },
    { ...safeStorage, getSelectedStorageBackend: () => "basic_text" },
  ]) {
    const auth = createBrowserBridgeAuth({ dataDir: f.dataDir, safeStorage: unavailable });
    assert.equal(auth.getStatus().pairingAvailable, false);
    assert.throws(() => auth.beginPairing(23333), { code: "secure_storage_unavailable" });
  }
});

test("revoking a client invalidates a challenge already in progress", (t) => {
  const f = fixture(t);
  const handshake = f.auth.challenge(f.hello, 23334);
  f.auth.authenticate(handshake, mac(f.pairing.secret, "client-proof", handshake.context));
  const key = mac(f.pairing.secret, "credential", handshake.context);
  f.auth.confirm(handshake, mac(key, "pair-confirm", handshake.context));
  const resumed = f.auth.challenge(validateHello({ ...f.hello, mode: "resume", credentialId: "client-1" }), 23334);
  f.auth.removeClient("client-1");
  assert.throws(() => f.auth.authenticate(resumed, mac(key, "client-proof", resumed.context)), { code: "credential_changed" });
});

test("browser event schema rejects conversation content and arbitrary URLs", () => {
  const event = { type: "event", v: 1, eventId: "event", browserRunId: "run", sessionId: "session", sequence: 1,
    kind: "observation", provider: "chatgpt", tabId: 1, pageInstanceId: "page", routeRevision: 0,
    conversationRef: "/c/id", turnId: null, generation: 0, phase: "idle", outcome: null,
    observation: "fresh", observedAt: Date.now(), replay: false };
  assert.equal(validateEvent(event).conversationRef, "/c/id");
  assert.throws(() => validateEvent({ ...event, prompt: "must not leave the page" }), { code: "invalid_schema" });
  assert.throws(() => validateEvent({ ...event, conversationRef: "https://attacker.example/c/id" }), { code: "invalid_conversation" });
  assert.throws(() => validateEvent({ ...event, conversationRef: "/c/id?secret=private" }), { code: "invalid_conversation" });
  assert.throws(() => validateEvent({ ...event, kind: "terminal", phase: "settled", outcome: "completed" }), { code: "invalid_event" });
});

module.exports = { safeStorage };
