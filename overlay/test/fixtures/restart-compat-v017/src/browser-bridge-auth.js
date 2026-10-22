const crypto = require("node:crypto");
const path = require("node:path");
const { openJsonFile } = require("./browser-bridge-persistence");
const { VERSION, PRODUCT_ID, isId, isSecret, isInteger, protocolError, mac, verifyMac } = require("./browser-bridge-protocol");

const PAIR_TTL_MS = 2 * 60 * 1000;
const MAX_CLIENTS = 3;

function createBrowserBridgeAuth({ dataDir, safeStorage, now = Date.now, fs } = {}) {
  const persistenceOptions = fs ? { fs } : {};
  const identityFile = openJsonFile(path.join(dataDir, "identity.json"), (value) => {
    if (value?.version !== VERSION || value?.productId !== PRODUCT_ID || !isId(value.instanceId)) throw new Error("Invalid browser identity");
  }, persistenceOptions);
  const identity = identityFile.value || { version: VERSION, productId: PRODUCT_ID, instanceId: crypto.randomUUID() };
  if (!identityFile.value) identityFile.write(identity);
  const serverRunId = crypto.randomUUID();
  let pairing = null;
  let unavailable = null;
  let credentials = [];
  let credentialFile = null;
  function storageReady() {
    return !!safeStorage?.isEncryptionAvailable?.()
      && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  }
  function validateCredential(value) {
    if (!value || !isId(value.clientId) || !isSecret(value.key)
      || !["pending", "active"].includes(value.state)
      || !isInteger(value.createdAt) || !isInteger(value.expiresAt)) throw new Error("Invalid browser credential");
  }
  function decodeVault(value) {
    if (value?.version !== VERSION || value.instanceId !== identity.instanceId || typeof value.sealed !== "string") throw new Error("Invalid browser credential vault");
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(value.sealed, "base64")));
    if (parsed?.version !== VERSION || !Array.isArray(parsed.credentials) || parsed.credentials.length > MAX_CLIENTS) throw new Error("Invalid browser credential vault");
    parsed.credentials.forEach(validateCredential);
    if (new Set(parsed.credentials.map((entry) => entry.clientId)).size !== parsed.credentials.length) throw new Error("Duplicate browser client");
    return parsed.credentials;
  }
  try {
    if (!storageReady()) throw protocolError("secure_storage_unavailable", "OS-protected key storage is unavailable; pairing has been disabled.");
    credentialFile = openJsonFile(path.join(dataDir, "credentials.json"), decodeVault, persistenceOptions);
    if (credentialFile.value) credentials = decodeVault(credentialFile.value);
  } catch (error) { unavailable = error.code || "credential_store_unreadable"; }

  function ensureReady() {
    if (unavailable || !storageReady()) throw protocolError(unavailable || "secure_storage_unavailable");
  }
  function save(next) {
    ensureReady();
    next.forEach(validateCredential);
    const sealed = safeStorage.encryptString(JSON.stringify({ version: VERSION, credentials: next })).toString("base64");
    credentialFile.write({ version: VERSION, instanceId: identity.instanceId, sealed });
    credentials = next;
  }
  function liveCredentials() {
    return credentials.filter((entry) => entry.state === "active" || entry.expiresAt > now());
  }
  function findCredential(clientId) {
    return liveCredentials().find((entry) => entry.clientId === clientId);
  }
  return {
    instanceId: identity.instanceId,
    serverRunId,
    getStatus() {
      return {
        instanceId: identity.instanceId, serverRunId,
        pairingAvailable: !unavailable && storageReady(), error: unavailable,
        pairedClients: liveCredentials().filter((entry) => entry.state === "active").map(({ clientId, createdAt }) => ({ clientId, createdAt })),
        recovery: identityFile.recovery || credentialFile?.recovery || null,
      };
    },
    beginPairing(port) {
      ensureReady();
      if (!isInteger(port, 1) || port > 65535) throw protocolError("invalid_port");
      pairing = {
        v: VERSION, productId: PRODUCT_ID, instanceId: identity.instanceId,
        pairingId: crypto.randomUUID(), port, secret: crypto.randomBytes(32).toString("base64url"), expiresAt: now() + PAIR_TTL_MS,
      };
      return { code: `mori1:${Buffer.from(JSON.stringify(pairing)).toString("base64url")}`, expiresAt: pairing.expiresAt };
    },
    challenge(hello, port) {
      ensureReady();
      if (hello.instanceId !== identity.instanceId) throw protocolError("identity_mismatch");
      let key;
      if (hello.mode === "pair") {
        if (!pairing || pairing.pairingId !== hello.credentialId || pairing.expiresAt <= now() || pairing.port !== port) throw protocolError("pairing_expired");
        if (pairing.claimedBy && pairing.claimedBy !== hello.clientId) throw protocolError("pairing_in_use");
        if (!findCredential(hello.clientId) && liveCredentials().length >= MAX_CLIENTS) throw protocolError("client_limit");
        key = pairing.secret;
      } else {
        const credential = findCredential(hello.clientId);
        if (!credential) throw protocolError("unknown_client");
        key = credential.key;
      }
      const context = {
        type: "challenge", v: VERSION, mode: hello.mode, credentialId: hello.credentialId,
        clientId: hello.clientId, productId: PRODUCT_ID, instanceId: identity.instanceId,
        serverRunId, port, clientNonce: hello.clientNonce, serverNonce: crypto.randomBytes(32).toString("base64url"),
      };
      return { context, key, message: { ...context, proof: mac(key, "server-proof", context) } };
    },
    authenticate(handshake, proof) {
      ensureReady();
      const { context, key } = handshake;
      if (!verifyMac(proof, key, "client-proof", context)) throw protocolError("authentication_failed");
      if (context.mode === "pair") {
        if (!pairing || pairing.pairingId !== context.credentialId || pairing.expiresAt <= now()
          || (pairing.claimedBy && pairing.claimedBy !== context.clientId)) throw protocolError("pairing_expired");
        const nextKey = mac(key, "credential", context);
        const entry = { clientId: context.clientId, key: nextKey, state: "pending", createdAt: now(), expiresAt: now() + PAIR_TTL_MS };
        const next = liveCredentials().filter((item) => item.clientId !== context.clientId);
        if (next.length >= MAX_CLIENTS) throw protocolError("client_limit");
        save([...next, entry]);
        pairing.claimedBy = context.clientId;
        handshake.pendingKey = nextKey;
        return { type: "pair.ready", clientId: context.clientId, credentialId: context.clientId };
      }
      const entry = findCredential(context.clientId);
      if (!entry || entry.key !== key) throw protocolError("credential_changed");
      if (entry.state === "pending") {
        save(liveCredentials().map((item) => item.clientId === context.clientId ? { ...item, state: "active", expiresAt: 0 } : item));
        if (pairing?.claimedBy === context.clientId) pairing = null;
      }
      return { type: "ready" };
    },
    confirm(handshake, proof) {
      ensureReady();
      const entry = findCredential(handshake.context.clientId);
      if (!entry || entry.state !== "pending" || entry.key !== handshake.pendingKey
        || !verifyMac(proof, entry.key, "pair-confirm", handshake.context)) throw protocolError("confirmation_failed");
      save(liveCredentials().map((item) => item.clientId === entry.clientId ? { ...item, state: "active", expiresAt: 0 } : item));
      pairing = null;
    },
    removeClient(clientId) {
      ensureReady();
      if (!isId(clientId)) throw protocolError("invalid_client");
      save(liveCredentials().filter((entry) => entry.clientId !== clientId));
      if (pairing?.claimedBy === clientId) pairing = null;
    },
    dispose() { pairing = null; credentials = []; },
  };
}

module.exports = { createBrowserBridgeAuth, PAIR_TTL_MS, MAX_CLIENTS };
