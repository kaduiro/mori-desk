"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openJsonFile } = require("./browser-bridge-persistence");
const { readClientConfig } = require("./mori-calendar-client-config");
const { email, ID_RE, MAX_SENDERS } = require("./mori-mail-core");

const DAY = 86400000;
const MINUTE = 60000;
const MAX_DAY_UNITS = 20000;
const MAX_MINUTE_UNITS = 2500;

function createMailStore({ dataDir, safeStorage, fsImpl = fs }) {
  let client = null;
  try { client = readClientConfig(path.join(dataDir, "client.json"), fsImpl); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("client-invalid"); }
  const sealed = (name, maxBytes = 2600000) => openJsonFile(path.join(dataDir, name), value => {
    if (value?.version !== 1 || typeof value.sealed !== "string" || value.sealed.length > maxBytes - 100)
      throw new Error("invalid-mail-store");
  }, { fs: fsImpl, maxBytes });
  const auth = sealed("auth.json"), cache = sealed("cache.json", 16000000), settings = sealed("settings.json");
  const ledger = openJsonFile(path.join(dataDir, "requests.json"), value => {
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 12000
      || !value.entries.every(item => Number.isSafeInteger(item?.at) && Number.isSafeInteger(item?.units)
        && item.units > 0 && item.units <= 100)) throw new Error("invalid-mail-ledger");
  }, { fs: fsImpl, maxBytes: 300000 });
  const secure = () => safeStorage?.isEncryptionAvailable?.()
    && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  function decrypt(file) {
    if (!file.value) return null;
    if (!secure()) throw new Error("secure-storage-unavailable");
    return JSON.parse(safeStorage.decryptString(Buffer.from(file.value.sealed, "base64")));
  }
  function encrypt(file, value) {
    if (!secure()) throw new Error("secure-storage-unavailable");
    file.write({ version: 1, sealed: safeStorage.encryptString(JSON.stringify(value)).toString("base64") });
  }
  function remove(name) {
    for (const suffix of ["", ".bak"]) {
      try { fsImpl.unlinkSync(path.join(dataDir, name + suffix)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const fingerprint = () => client ? crypto.createHash("sha256").update(client.clientId).digest("hex") : null;
  return {
    get client() { return client; }, secure,
    reloadClient() { client = readClientConfig(path.join(dataDir, "client.json"), fsImpl); return client; },
    readAuth() {
      const value = decrypt(auth);
      if (!value) return null;
      if (value.version !== 1 || value.fingerprint !== fingerprint() || !email(value.account)
        || typeof value.refreshToken !== "string" || !value.refreshToken || value.refreshToken.length > 10000)
        throw new Error("mail-auth-invalid");
      return value;
    },
    saveAuth(account, refreshToken) {
      if (!email(account) || typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 10000)
        throw new Error("mail-auth-invalid");
      encrypt(auth, { version: 1, fingerprint: fingerprint(), account: email(account), refreshToken });
    },
    readSettings() {
      const value = decrypt(settings) || { version: 1, senders: [], hidden: [] };
      if (value.version !== 1 || !Array.isArray(value.senders) || value.senders.length > MAX_SENDERS
        || !value.senders.every(item => email(item) === item)
        || !Array.isArray(value.hidden) || value.hidden.length > 5000
        || !value.hidden.every(item => ID_RE.test(item))) throw new Error("mail-settings-invalid");
      return value;
    },
    saveSettings(value) { encrypt(settings, { version: 1, senders: value.senders, hidden: value.hidden }); },
    readCache(account) {
      const value = decrypt(cache);
      if (!value || value.version !== 1 || value.account !== account) return null;
      if (!Array.isArray(value.rows) || value.rows.length > 5000 || typeof value.historyId !== "string"
        || !/^\d+$/.test(value.historyId) || !Number.isSafeInteger(value.fetchedAt))
        throw new Error("mail-cache-invalid");
      if (value.pending && (!/^\d+$/.test(value.pending.historyId || "")
        || !Array.isArray(value.pending.changes) || value.pending.changes.length > 5000
        || !value.pending.changes.every(item => Array.isArray(item) && item.length === 2
          && ID_RE.test(item[0]) && ["added", "changed", "deleted"].includes(item[1]))))
        throw new Error("mail-cache-invalid");
      return value;
    },
    saveCache(value) { encrypt(cache, { version: 1, ...value }); },
    reserve(at, units) {
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(units) || units < 1 || units > 100)
        throw new Error("invalid-mail-request");
      const recent = (ledger.value?.entries || []).filter(item => item.at <= at && item.at > at - DAY);
      const minute = recent.filter(item => item.at > at - MINUTE);
      const dayUnits = recent.reduce((sum, item) => sum + item.units, 0);
      const minuteUnits = minute.reduce((sum, item) => sum + item.units, 0);
      if (dayUnits + units > MAX_DAY_UNITS) return { allowed: false, reason: "local-limit", nextAt: recent[0]?.at + DAY };
      if (minuteUnits + units > MAX_MINUTE_UNITS) return { allowed: false, reason: "minute-limit", nextAt: minute[0]?.at + MINUTE };
      ledger.write({ version: 1, entries: [...recent, { at, units }] });
      return { allowed: true };
    },
    usage(at) {
      const recent = (ledger.value?.entries || []).filter(item => item.at > at - DAY && item.at <= at);
      return { units: recent.reduce((sum, item) => sum + item.units, 0), limit: MAX_DAY_UNITS };
    },
    disconnect() {
      for (const name of ["auth.json", "cache.json", "settings.json"]) remove(name);
      auth.value = cache.value = settings.value = null;
    },
  };
}

module.exports = { createMailStore, MAX_DAY_UNITS, MAX_MINUTE_UNITS };
