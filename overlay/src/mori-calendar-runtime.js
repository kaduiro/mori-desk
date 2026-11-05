"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createCalendarStore } = require("./mori-calendar-store");
const { dayBounds, DAY_MS, MAX_REQUESTS, MANUAL_INTERVAL_MS, AUTO_INTERVAL_MS,
  MULTI_AUTO_INTERVAL_MS, cycleAllowance, sortEvents } = require("./mori-calendar-core");
const api = require("./mori-calendar-api");

function createCalendarRuntime({ dataDir, safeStorage, shell, managedClientFile = null,
  fetchImpl = fetch, now = Date.now, onChange = () => {} }) {
  let store;
  let setupError = null;
  try { store = createCalendarStore({ dataDir, safeStorage, managedClientFile }); }
  catch (error) { setupError = error.message || "storage-error"; }
  let state = { status: setupError ? "storage-error" : "loading", reason: setupError,
    date: dayBounds(new Date(now())).key, events: [], fetchedAt: null, nextAt: null, fromCache: false,
    selectedIds: ["primary"], calendars: [], listScope: false, listStatus: "unknown", sources: [],
    selectionConfirmed: false };
  let accessToken = null, accessExpiresAt = 0, tail = Promise.resolve(), timer = null, disposed = false, generation = 0;
  function queue(task) {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  }
  function snapshot() {
    return { ...state, events: state.events.map(event => ({ ...event })),
      selectedIds: [...state.selectedIds], calendars: state.calendars.map(item => ({ ...item })),
      sources: state.sources.map(item => ({ ...item })), configSource: store?.clientSource || null,
      managedAvailable: !!store?.managedAvailable, managedDiffers: !!store?.managedDiffers };
  }
  function diagnostics() {
    let requestCount = null, nextManualAt = null, nextAutoAt = null, pausedUntil = null;
    try {
      const ledger = store?.ledger();
      if (ledger) {
        const recent = ledger.times.filter(value => value <= now() && value > now() - DAY_MS);
        requestCount = recent.length;
        pausedUntil = ledger.pausedUntil > now() ? ledger.pausedUntil : null;
        const limitAt = recent.length >= MAX_REQUESTS ? Math.min(...recent) + DAY_MS : 0;
        nextManualAt = Math.max(limitAt, ledger.eventCycleAt ? ledger.eventCycleAt + MANUAL_INTERVAL_MS : 0,
          pausedUntil || 0) || null;
        nextAutoAt = Math.max(limitAt, ledger.eventCycleAt ? ledger.eventCycleAt
          + (state.selectedIds.length > 1 ? MULTI_AUTO_INTERVAL_MS : AUTO_INTERVAL_MS) : 0,
          pausedUntil || 0) || null;
      }
    } catch { /* Diagnostics must not modify or repair an unreadable ledger. */ }
    return { ...snapshot(), requestCount, requestLimit: MAX_REQUESTS,
      nextManualAt, nextAutoAt, pausedUntil };
  }
  function publish(partial) {
    state = { ...state, ...partial };
    try { onChange(); } catch {}
    return snapshot();
  }
  function sourceName(id, calendars = state.calendars) {
    return calendars.find(item => item.id === id)?.name || (id === "primary" ? "メイン" : id.slice(0, 80));
  }
  function combine(ids, sources, statuses, calendars) {
    return sortEvents(ids.flatMap(id => (sources[id]?.events || []).map(event => ({
      ...event, key: crypto.createHash("sha256").update(id + "\0" + event.id).digest("hex").slice(0, 32),
      sourceId: id, sourceName: sourceName(id, calendars), cached: statuses[id] !== "success",
    }))));
  }
  function sourceRows(ids, sources, statuses, calendars) {
    return ids.map(id => ({ id, name: sourceName(id, calendars), status: statuses[id] || "missing",
      fetchedAt: sources[id]?.fetchedAt || null }));
  }
  function context() {
    const auth = store.readAuth();
    if (!auth) return null;
    const settings = store.readSettings(auth.generation);
    const date = dayBounds(new Date(now())).key;
    return { auth, settings, date, sources: store.readCache(date, auth.generation) || {} };
  }
  function schedule() {
    if (!timer) timer = setInterval(() => {
      if (!disposed) { void refresh(false); void loadCalendars(false); }
    }, 60000);
  }
  function start() {
    if (disposed || setupError) return snapshot();
    if (!store.clientId) return publish({ status: "config-needed", reason: null });
    if (!store.secure()) return publish({ status: "secure-storage-unavailable", reason: null });
    let current;
    try { current = context(); }
    catch (error) { return publish({ status: error.message === "calendar-client-changed" ? "config-changed" : "storage-error",
      reason: error.message === "calendar-client-changed" ? "calendar-client-changed" : "calendar-store-unreadable" }); }
    if (!current) return publish({ status: "unlinked", reason: null });
    const { auth, settings, date, sources } = current;
    const ids = settings.ids;
    const statuses = Object.fromEntries(ids.map(id => [id, sources[id] ? "cached" : "missing"]));
    const fetchedAt = Math.max(0, ...ids.map(id => sources[id]?.fetchedAt || 0)) || null;
    publish({ date, selectedIds: ids, calendars: settings.calendars, listScope: auth.listScope,
      selectionConfirmed: settings.onboardingComplete,
      listStatus: !auth.listScope ? "scope-needed" : settings.listPermissionDenied ? "permission-denied"
        : settings.calendars.length ? "ready" : "loading",
      events: combine(ids, sources, statuses, settings.calendars), fetchedAt, fromCache: !!fetchedAt,
      sources: sourceRows(ids, sources, statuses, settings.calendars),
      status: ids.length ? fetchedAt ? "ready" : "loading" : "no-selection", reason: null });
    void refresh(false);
    if (auth.listScope) void loadCalendars(false);
    schedule();
    return snapshot();
  }
  async function getAccess(auth) {
    if (!accessToken || accessExpiresAt <= now() + 60000) {
      const refreshed = await api.refreshToken(store.clientId, store.clientSecret, auth.refreshToken, fetchImpl);
      accessToken = refreshed.accessToken;
      accessExpiresAt = refreshed.expiresAt;
    }
    return accessToken;
  }
  function allowance(at, kind, manual, count) {
    const ledger = store.ledger();
    if (ledger.pausedUntil > at) return { allowed: false, reason: "google-quota", nextAt: ledger.pausedUntil };
    const recent = ledger.times.filter(value => value <= at && value > at - DAY_MS).sort((a, b) => a - b);
    if (recent.length >= MAX_REQUESTS) return { allowed: false, reason: "local-limit", nextAt: recent[0] + DAY_MS };
    if (kind === "event") return cycleAllowance(ledger.eventCycleAt || 0, at, manual, count);
    const interval = manual ? 5 * 60 * 1000 : DAY_MS;
    return ledger.listAttemptAt && at - ledger.listAttemptAt < interval
      ? { allowed: false, reason: "interval", nextAt: ledger.listAttemptAt + interval }
      : { allowed: true };
  }
  function reserve(at, kind, first, manual, count) {
    let result;
    try { result = store.reserveRequest(at, kind, { manual: first ? manual : null, selectedCount: count }); }
    catch { throw Object.assign(new Error("storage-error"), { code: "storage-error" }); }
    if (!result.allowed) throw Object.assign(new Error(result.reason), { code: result.reason, nextAt: result.nextAt });
  }
  async function refresh(manual = false) {
    return queue(async () => {
      if (disposed || setupError || !store?.clientId) return snapshot();
      const currentGeneration = generation;
      let current;
      try { current = context(); }
      catch (error) { return publish({ status: error.message === "calendar-client-changed" ? "config-changed" : "storage-error",
        reason: error.message === "calendar-client-changed" ? "calendar-client-changed" : "calendar-store-unreadable" }); }
      if (!current) return publish({ status: "unlinked", events: [], fetchedAt: null });
      const { auth, settings, date } = current, ids = settings.ids;
      const sources = Object.fromEntries(ids.filter(id => current.sources[id]).map(id => [id, current.sources[id]]));
      const statuses = Object.fromEntries(ids.map(id => [id, sources[id] ? "cached" : "missing"]));
      if (date !== state.date) publish({ date, events: combine(ids, sources, statuses, settings.calendars),
        fetchedAt: null, fromCache: !!Object.keys(sources).length });
      if (!ids.length) return publish({ status: "no-selection", selectedIds: ids, events: [], sources: [] });
      if (state.status === "auth-expired" && !manual) return snapshot();
      let check;
      try { check = allowance(now(), "event", manual, ids.length); }
      catch { return publish({ status: "storage-error", reason: "request-ledger-unreadable" }); }
      if (!check.allowed) return publish({
        status: check.reason === "google-quota" ? "quota-paused" : check.reason === "local-limit"
          ? "local-limit" : state.events.length || state.fetchedAt ? "ready" : "waiting",
        reason: check.reason, nextAt: check.nextAt,
      });
      publish({ status: "loading", reason: null, nextAt: null, selectedIds: ids });
      try { await getAccess(auth); }
      catch (error) {
        try { store.markAttempt(now(), "event"); }
        catch { return publish({ status: "storage-error", reason: "request-ledger-unwritable" }); }
        return publish({ status: error.code === "auth-expired" ? "auth-expired" : "failed",
          reason: error.code || "auth-failed", nextAt: null });
      }
      let first = true, blocked = null, cacheSaved = true;
      const cycleNow = new Date(now());
      for (const id of ids) {
        try {
          const result = await api.listToday({ accessToken, fetchImpl, now: cycleNow, calendarId: id,
            requestPage: async () => { reserve(now(), "event", first, manual, ids.length); first = false; } });
          if (disposed || generation !== currentGeneration) return snapshot();
          sources[id] = { events: result.events, fetchedAt: now() };
          statuses[id] = "success";
        } catch (error) {
          if (disposed || generation !== currentGeneration) return snapshot();
          const code = error.code || "calendar-failed";
          statuses[id] = code;
          if (["google-quota", "local-limit", "auth-expired", "storage-error"].includes(code)) { blocked = error; break; }
        }
      }
      if (blocked) {
        const index = ids.findIndex(id => statuses[id] === blocked.code);
        for (const id of ids.slice(index + 1)) statuses[id] = sources[id] ? "cached" : "missing";
      }
      if (blocked?.code === "google-quota") {
        try { store.pauseUntil(now() + DAY_MS); }
        catch { return publish({ status: "storage-error", reason: "quota-stop-not-saved" }); }
      }
      try { store.saveSources(date, auth.generation, sources); }
      catch { cacheSaved = false; }
      if (dayBounds(new Date(now())).key !== date)
        return publish({ date: dayBounds(new Date(now())).key, status: "waiting", reason: "day-changed",
          events: [], sources: [], fetchedAt: null, fromCache: false });
      const rows = sourceRows(ids, sources, statuses, settings.calendars);
      const complete = rows.every(row => row.status === "success");
      const fetchedAt = Math.max(0, ...rows.map(row => row.fetchedAt || 0)) || null;
      const status = blocked?.code === "storage-error" ? "storage-error"
        : blocked?.code === "google-quota" ? "quota-paused"
        : blocked?.code === "local-limit" ? "local-limit"
          : blocked?.code === "auth-expired" ? "auth-expired" : complete ? "ready" : "partial";
      const nextAt = blocked?.code === "google-quota" ? store.ledger().pausedUntil
        : blocked?.code === "local-limit" ? blocked.nextAt : null;
      return publish({ status, reason: blocked?.code || (!complete ? "partial" : null), date,
        events: combine(ids, sources, statuses, settings.calendars), sources: rows, fetchedAt,
        fromCache: rows.some(row => row.status === "cached"), nextAt, cacheSaved });
    });
  }
  async function loadCalendars(manual = false) {
    return queue(async () => {
      if (disposed || setupError || !store?.clientId) return snapshot();
      let current;
      try { current = context(); }
      catch { return publish({ listStatus: "storage-error" }); }
      if (!current) return snapshot();
      const { auth, settings } = current;
      if (!auth.listScope) return publish({ listScope: false, listStatus: "scope-needed" });
      if (state.status === "auth-expired" && !manual) return snapshot();
      if (settings.listPermissionDenied) return publish({ listStatus: "permission-denied" });
      let check;
      try { check = allowance(now(), "list", manual, 0); }
      catch { return publish({ listStatus: "storage-error" }); }
      if (!check.allowed) return publish({ listStatus: check.reason === "interval" ? "waiting"
        : check.reason === "local-limit" ? "local-limit" : "google-quota",
        listNextAt: check.nextAt || null });
      const currentGeneration = generation;
      try {
        try { await getAccess(auth); }
        catch (error) {
          store.markAttempt(now(), "list");
          throw error;
        }
        let first = true;
        const result = await api.listCalendars({ accessToken, fetchImpl,
          requestPage: async () => { reserve(now(), "list", first, manual, 0); first = false; } });
        if (disposed || generation !== currentGeneration) return snapshot();
        const calendars = result.map(item => ({ ...item, id: item.primary ? "primary" : item.id }));
        store.saveCalendars(auth.generation, calendars);
        return publish({ calendars, listStatus: "ready", listScope: true,
          events: state.events.map(event => ({ ...event, sourceName: sourceName(event.sourceId, calendars) })),
          sources: state.sources.map(row => ({ ...row, name: sourceName(row.id, calendars) })) });
      } catch (error) {
        if (disposed || generation !== currentGeneration) return snapshot();
        if (error.code === "google-quota") {
          try { store.pauseUntil(now() + DAY_MS); }
          catch { return publish({ listStatus: "storage-error" }); }
          publish({ status: "quota-paused", reason: "google-quota", nextAt: store.ledger().pausedUntil });
        }
        if (error.code === "auth-expired") publish({ status: "auth-expired", reason: "auth-expired" });
        if (error.code === "permission-denied") {
          try { store.saveCalendars(auth.generation, settings.calendars, true); }
          catch { return publish({ listStatus: "storage-error" }); }
        }
        return publish({ listStatus: error.code || "failed" });
      }
    });
  }
  async function selectCalendars(ids) {
    const result = await queue(async () => {
      if (disposed || setupError) return { ok: false, reason: "unavailable" };
      let current;
      try { current = context(); }
      catch { return { ok: false, reason: "storage-error" }; }
      if (!current) return { ok: false, reason: "unlinked" };
      if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length
        || !ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 512))
        return { ok: false, reason: "invalid-selection" };
      if (!ids.every(id => id === "primary" || current.auth.listScope
        && current.settings.calendars.some(item => item.id === id && item.readable)))
        return { ok: false, reason: "invalid-selection" };
      try { store.saveSelection(current.auth.generation, ids); }
      catch { return { ok: false, reason: "storage-error" }; }
      const sources = Object.fromEntries(ids.filter(id => current.sources[id]).map(id => [id, current.sources[id]]));
      const statuses = Object.fromEntries(ids.map(id => [id, sources[id] ? "cached" : "missing"]));
      publish({ selectedIds: ids, selectionConfirmed: true,
        events: combine(ids, sources, statuses, current.settings.calendars),
        sources: sourceRows(ids, sources, statuses, current.settings.calendars),
        status: ids.length ? "waiting" : "no-selection", reason: null });
      return { ok: true };
    });
    if (result.ok && ids.length) await refresh(true);
    return result.ok ? { ok: true, ...snapshot() } : result;
  }
  async function connect() {
    const result = await queue(async () => {
      if (disposed || setupError || !store?.clientId) return snapshot();
      if (!store.secure()) return publish({ status: "secure-storage-unavailable" });
      const currentGeneration = generation;
      let previous;
      try { previous = context(); }
      catch (error) { if (error.message !== "calendar-client-changed")
        return publish({ status: "storage-error", reason: "calendar-store-unreadable" });
        previous = null;
      }
      const before = snapshot();
      publish({ status: "authorizing", reason: null });
      try {
        const authorized = await api.authorize({ clientId: store.clientId,
          clientSecret: store.clientSecret, shell, fetchImpl });
        if (disposed || generation !== currentGeneration) return snapshot();
        if (previous && !authorized.listScope) return publish({ ...before, reason: "scope-denied",
          listStatus: "scope-needed" });
        store.clearListAttempt();
        store.saveAuth(authorized.refreshToken, authorized.listScope);
        accessToken = authorized.accessToken; accessExpiresAt = authorized.expiresAt;
        publish({ status: "loading", reason: null, events: [], fetchedAt: null, fromCache: false,
          selectedIds: ["primary"], calendars: [], sources: [], selectionConfirmed: false, listScope: authorized.listScope,
          listStatus: authorized.listScope ? "loading" : "scope-needed" });
        return { connected: true };
      } catch (error) {
        if (disposed || generation !== currentGeneration) return snapshot();
        return publish({ ...(previous ? before : {}), status: previous ? before.status : "auth-failed",
          reason: error?.code || error?.message || "auth-failed" });
      }
    });
    if (result?.connected) {
      schedule();
      await refresh(true);
      if (state.listScope) await loadCalendars(false);
    }
    return snapshot();
  }
  function disconnect() {
    if (!store || setupError) return snapshot();
    generation++;
    try { store.disconnect(); }
    catch { return publish({ status: "storage-error", reason: "disconnect-failed" }); }
    accessToken = null; accessExpiresAt = 0;
    if (timer) clearInterval(timer);
    timer = null;
    return publish({ status: "unlinked", reason: null, events: [], fetchedAt: null, fromCache: false,
      nextAt: null, selectedIds: ["primary"], calendars: [], sources: [], selectionConfirmed: false,
      listScope: false, listStatus: "unknown" });
  }
  function canImportClient() {
    if (!store) return true;
    try { return !store.readAuth(); }
    catch { return false; }
  }
  function reloadClient() {
    if (!canImportClient()) return { ok: false, reason: "disconnect-first" };
    try { store = createCalendarStore({ dataDir, safeStorage, managedClientFile }); setupError = null; }
    catch (error) { setupError = error.message || "calendar-client-config-invalid";
      return publish({ status: "storage-error", reason: setupError }); }
    generation++;
    return start();
  }
  function switchToManaged() {
    if (!store?.managedAvailable) return { ok: false, reason: "managed-config-unavailable" };
    if (!canImportClient()) return { ok: false, reason: "disconnect-first" };
    if (store.clientSource === "managed") return { ok: true, ...diagnostics() };
    const file = path.join(dataDir, "client.json");
    const backup = path.join(dataDir, `.client-switch-${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      fs.renameSync(file, backup);
      const nextStore = createCalendarStore({ dataDir, safeStorage, managedClientFile });
      if (nextStore.clientSource !== "managed") throw new Error("managed-config-unavailable");
      fs.unlinkSync(backup);
      store = nextStore;
      setupError = null;
      generation++;
      accessToken = null; accessExpiresAt = 0;
      start();
      return { ok: true, ...diagnostics() };
    } catch {
      if (fs.existsSync(backup)) {
        try { fs.renameSync(backup, file); } catch { return { ok: false, reason: "config-restore-failed" }; }
      }
      return { ok: false, reason: "managed-switch-failed" };
    }
  }
  function dispose() {
    disposed = true; generation++;
    if (timer) clearInterval(timer);
    timer = null; accessToken = null;
  }
  return { start, refresh, loadCalendars, selectCalendars, connect, disconnect, dispose,
    snapshot, diagnostics, canImportClient, reloadClient, switchToManaged };
}

module.exports = { createCalendarRuntime };
