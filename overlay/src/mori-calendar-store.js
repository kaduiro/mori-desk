"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openJsonFile } = require("./browser-bridge-persistence");
const { DAY_MS, MAX_REQUESTS, cycleAllowance, MANUAL_INTERVAL_MS } = require("./mori-calendar-core");
const { CLIENT_ID_RE, readClientConfig } = require("./mori-calendar-client-config");

function createCalendarStore({ dataDir, safeStorage, managedClientFile = null, fsImpl = fs }) {
  const clientFile = path.join(dataDir, "client.json");
  function optionalClient(file) {
    if (!file) return null;
    try { return readClientConfig(file, fsImpl); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("calendar-client-config-invalid");
    }
  }
  const personalClient = optionalClient(clientFile);
  const managedClient = optionalClient(managedClientFile);
  const client = personalClient || managedClient;
  const clientId = client?.clientId || null;
  const clientSecret = client?.clientSecret || null;
  const clientSource = personalClient ? "personal" : managedClient ? "managed" : null;
  const managedDiffers = !!(personalClient && managedClient
    && (personalClient.clientId !== managedClient.clientId
      || personalClient.clientSecret !== managedClient.clientSecret));

  const secure = () => safeStorage?.isEncryptionAvailable?.()
    && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  function requireSecure() {
    if (!secure()) throw new Error("secure-storage-unavailable");
  }
  function sealedFile(name) {
    return openJsonFile(path.join(dataDir, name), value => {
      if (value?.version !== 1 || typeof value.sealed !== "string" || value.sealed.length > 300000)
        throw new Error("invalid-calendar-vault");
    }, { fs: fsImpl, maxBytes: 310000 });
  }
  const auth = sealedFile("auth.json");
  const cache = sealedFile("cache.json");
  const settings = sealedFile("selection.json");
  const ledger = openJsonFile(path.join(dataDir, "requests.json"), value => {
    if (value?.version !== 1 || !Array.isArray(value.times) || value.times.length > 100
      || !value.times.every(Number.isSafeInteger)
      || !Number.isSafeInteger(value.pausedUntil || 0)
      || !Number.isSafeInteger(value.eventCycleAt || 0)
      || !Number.isSafeInteger(value.listAttemptAt || 0)) throw new Error("invalid-calendar-requests");
  }, { fs: fsImpl, maxBytes: 10000 });

  function decrypt(file) {
    if (!file.value) return null;
    requireSecure();
    return JSON.parse(safeStorage.decryptString(Buffer.from(file.value.sealed, "base64")));
  }
  function encrypt(file, value) {
    requireSecure();
    file.write({ version: 1, sealed: safeStorage.encryptString(JSON.stringify(value)).toString("base64") });
  }
  function remove(name) {
    for (const suffix of ["", ".bak"]) {
      try { fsImpl.unlinkSync(path.join(dataDir, name + suffix)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return {
    clientId,
    clientSecret,
    clientSource,
    managedAvailable: !!managedClient,
    managedDiffers,
    clientFingerprint: clientId ? crypto.createHash("sha256").update(clientId).digest("hex") : null,
    secure,
    readAuth() {
      const value = decrypt(auth);
      if (value == null) return null;
      if (![1, 2, 3].includes(value.version) || typeof value.refreshToken !== "string" || !value.refreshToken
        || (value.version >= 2 && (typeof value.generation !== "string" || !/^[a-f0-9]{32}$/.test(value.generation)
          || typeof value.listScope !== "boolean"))
        || (value.version === 3 && (typeof value.clientFingerprint !== "string"
          || !/^[a-f0-9]{64}$/.test(value.clientFingerprint)))) throw new Error("invalid-calendar-auth");
      if (value.version === 3 && value.clientFingerprint !== this.clientFingerprint)
        throw new Error("calendar-client-changed");
      return { refreshToken: value.refreshToken, generation: value.version === 1 ? "legacy" : value.generation,
        listScope: value.version >= 2 && value.listScope };
    },
    readToken() { return this.readAuth()?.refreshToken || null; },
    saveToken(refreshToken) {
      if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 10000) throw new Error("invalid-calendar-token");
      encrypt(auth, { version: 1, refreshToken });
    },
    saveAuth(refreshToken, listScope) {
      if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 10000
        || typeof listScope !== "boolean") throw new Error("invalid-calendar-auth");
      const generation = crypto.randomBytes(16).toString("hex");
      encrypt(auth, { version: 3, refreshToken, listScope, generation,
        clientFingerprint: this.clientFingerprint });
      return generation;
    },
    readSettings(generation) {
      const value = decrypt(settings);
      if (!value || value.version !== 1 || value.generation !== generation)
        return { ids: ["primary"], calendars: [], listPermissionDenied: false, onboardingComplete: false };
      if (!Array.isArray(value.ids) || value.ids.length > 3 || new Set(value.ids).size !== value.ids.length
        || !value.ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 512))
        throw new Error("invalid-calendar-selection");
      if (!Array.isArray(value.calendars || []) || (value.calendars || []).length > 500)
        throw new Error("invalid-calendar-list");
      return { ids: value.ids, calendars: value.calendars || [],
        listPermissionDenied: value.listPermissionDenied === true,
        onboardingComplete: value.onboardingComplete === true };
    },
    readSelection(generation) { return this.readSettings(generation).ids; },
    saveSelection(generation, ids) {
      if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length
        || !ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 512))
        throw new Error("invalid-calendar-selection");
      const current = this.readSettings(generation);
      encrypt(settings, { version: 1, generation, ...current, ids, onboardingComplete: true });
    },
    saveCalendars(generation, calendars, listPermissionDenied = false) {
      if (!Array.isArray(calendars) || calendars.length > 500
        || !calendars.every(item => typeof item?.id === "string" && item.id.length <= 512
          && typeof item.name === "string" && item.name.length <= 160
          && typeof item.readable === "boolean")) throw new Error("invalid-calendar-list");
      const current = this.readSettings(generation);
      encrypt(settings, { version: 1, generation, ...current, calendars, listPermissionDenied });
    },
    readCache(key, generation = "legacy") {
      const value = decrypt(cache);
      if (!value || value.key !== key) return null;
      if (value.version === 1 && generation === "legacy" && Array.isArray(value.events)
        && Number.isSafeInteger(value.fetchedAt))
        return { primary: { events: value.events, fetchedAt: value.fetchedAt } };
      if (value.version !== 2 || value.generation !== generation || typeof value.sources !== "object"
        || !value.sources || Array.isArray(value.sources)) return null;
      for (const source of Object.values(value.sources)) {
        if (!Array.isArray(source?.events) || !Number.isSafeInteger(source.fetchedAt))
          throw new Error("invalid-calendar-cache");
      }
      return value.sources;
    },
    saveCache(key, events, fetchedAt) {
      encrypt(cache, { version: 1, key, events, fetchedAt });
    },
    saveSources(key, generation, sources) {
      encrypt(cache, { version: 2, key, generation, sources });
    },
    ledger() {
      const value = ledger.value || { version: 1, times: [], pausedUntil: 0 };
      return { ...value, eventCycleAt: value.eventCycleAt ?? Math.max(0, ...value.times),
        listAttemptAt: value.listAttemptAt || 0 };
    },
    clearListAttempt() {
      ledger.write({ ...this.ledger(), listAttemptAt: 0 });
    },
    markAttempt(at, kind) {
      if (!Number.isSafeInteger(at) || !["event", "list"].includes(kind)) throw new Error("invalid-calendar-attempt");
      const current = this.ledger();
      ledger.write({ ...current, [kind === "event" ? "eventCycleAt" : "listAttemptAt"]: at });
    },
    reserveRequest(at, kind, { manual = false, selectedCount = 1 } = {}) {
      if (!Number.isSafeInteger(at) || !["event", "list"].includes(kind)) throw new Error("invalid-calendar-request");
      const current = this.ledger();
      if (current.pausedUntil > at) return { allowed: false, reason: "google-quota", nextAt: current.pausedUntil };
      const recent = current.times.filter(value => value <= at && value > at - DAY_MS).sort((a, b) => a - b);
      if (recent.length >= MAX_REQUESTS) return { allowed: false, reason: "local-limit", nextAt: recent[0] + DAY_MS };
      if (kind === "event" && manual !== null) {
        const check = cycleAllowance(current.eventCycleAt || 0, at, manual, selectedCount);
        if (!check.allowed) return check;
      }
      if (kind === "list" && manual !== null) {
        const interval = manual ? MANUAL_INTERVAL_MS : DAY_MS;
        if (current.listAttemptAt && at - current.listAttemptAt < interval)
          return { allowed: false, reason: "interval", nextAt: current.listAttemptAt + interval };
      }
      const next = { ...current, times: [...recent, at] };
      if (kind === "event" && manual !== null) next.eventCycleAt = at;
      if (kind === "list" && manual !== null) next.listAttemptAt = at;
      ledger.write(next);
      return { allowed: true };
    },
    recordRequest(times, at) {
      const current = this.ledger();
      ledger.write({ version: 1, times: [...times, at], pausedUntil: current.pausedUntil });
    },
    pauseUntil(at) {
      const current = this.ledger();
      ledger.write({ ...current, pausedUntil: at });
    },
    disconnect() {
      remove("auth.json");
      remove("cache.json");
      remove("selection.json");
      auth.value = null;
      cache.value = null;
      settings.value = null;
    },
  };
}

module.exports = { createCalendarStore, CLIENT_ID_RE };
