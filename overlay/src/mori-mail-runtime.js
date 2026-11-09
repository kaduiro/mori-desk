"use strict";

const { createMailStore } = require("./mori-mail-store");
const { email, ID_RE, MAX_SENDERS, normalizeMessage, sections, plainBody } = require("./mori-mail-core");
const api = require("./mori-mail-api");

const AUTO_MS = 5 * 60000;
const MANUAL_MS = 60000;

function createMailRuntime({ dataDir, safeStorage, shell, fetchImpl = fetch,
  now = Date.now, onChange = () => {} }) {
  let store, setupError = null;
  try { store = createMailStore({ dataDir, safeStorage }); }
  catch { setupError = "storage-error"; }
  let settings = { senders: [], hidden: [] };
  let cache = null;
  let state = { status: setupError || "loading", reason: null, account: null,
    priority: [], unread: [], fetchedAt: null, nextAt: null, partial: false,
    nextPageToken: null, gap: false, pendingCount: 0,
    configSource: store?.client ? "personal" : null,
    senders: [], requestUnits: null, requestLimit: null,
    minuteUnits: null, minuteLimit: null };
  let accessToken = null, expiresAt = 0, timer = null, tail = Promise.resolve();
  let disposed = false, generation = 0, lastAttemptAt = 0, bodyCache = new Map();
  let connectedAccount = null, retryAt = 0, failures = 0;
  const current = expected => !disposed && generation === expected;
  const queue = task => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
  function snapshot() {
    return { ...state, priority: state.priority.map(row => ({ ...row })),
      unread: state.unread.map(row => ({ ...row })), senders: [...state.senders] };
  }
  function diagnostics() {
    let usage = null;
    try { usage = store?.usage(now()) || null; }
    catch { /* A damaged optional ledger must not make the HUD state call fail. */ }
    return { ...snapshot(), requestUnits: usage?.units ?? null,
      requestLimit: usage?.limit ?? null, minuteUnits: usage?.minuteUnits ?? null,
      minuteLimit: usage?.minuteLimit ?? null };
  }
  function publish(partial) {
    state = { ...state, ...partial };
    try { onChange(); } catch {}
    return snapshot();
  }
  function project(status = "ready", reason = null, nextAt = null) {
    const rows = sections(cache?.rows || [], settings.senders, settings.hidden);
    const usage = store?.usage(now());
    return publish({ status, reason, nextAt, account: cache?.account || connectedAccount,
      priority: rows.priority, unread: rows.unread, fetchedAt: cache?.fetchedAt || null,
      partial: !!cache?.nextPageToken || !!cache?.pending || cache?.gap === true,
      nextPageToken: cache?.nextPageToken || null,
      gap: cache?.gap === true, pendingCount: cache?.pending?.changes?.length || 0,
      senders: [...settings.senders], requestUnits: usage?.units ?? null,
      requestLimit: usage?.limit ?? null, minuteUnits: usage?.minuteUnits ?? null,
      minuteLimit: usage?.minuteLimit ?? null, configSource: store?.client ? "personal" : null });
  }
  function reserve(units) {
    try { return store.reserve(now(), units); }
    catch { throw api.failure("storage-error"); }
  }
  async function token(auth, force = false) {
    if (force) { accessToken = null; expiresAt = 0; }
    if (!accessToken || expiresAt <= now() + 60000) {
      const value = await api.refreshToken({ client: store.client,
        refreshToken: auth.refreshToken, fetchImpl });
      accessToken = value.accessToken; expiresAt = value.expiresAt;
    }
    return accessToken;
  }
  async function request(method, auth, fields = {}) {
    const args = { ...fields, accessToken: await token(auth), fetchImpl, reserve };
    try { return await api[method](args); }
    catch (error) {
      if (error.code !== "unauthorized") throw error;
      args.accessToken = await token(auth, true);
      return api[method](args);
    }
  }
  function accept(row, mode) {
    if (!row || row.excluded) return false;
    if (mode === "added" && settings.senders.includes(row.sender)) return true;
    return row.inbox && row.unread || settings.senders.includes(row.sender)
      && !settings.hidden.includes(row.id) && (cache?.rows || []).some(item => item.id === row.id);
  }
  async function metadata(auth, id) {
    const value = await request("message", auth, { id });
    return normalizeMessage(value);
  }
  async function bootstrap(auth, baseline = null, gap = false, expected = generation) {
    const retainedPriority = gap ? (cache?.rows || []).filter(row =>
      settings.senders.includes(row.sender) && !settings.hidden.includes(row.id)) : [];
    const prof = baseline ? { historyId: baseline, emailAddress: auth.account }
      : await request("profile", auth);
    if (email(prof.emailAddress) !== auth.account || !/^\d+$/.test(prof.historyId || ""))
      throw api.failure("account-mismatch");
    const page = await request("listUnread", auth);
    if (page.messages != null && !Array.isArray(page.messages)) throw api.failure("invalid-response");
    const rows = [];
    for (const item of page.messages || []) {
      if (!current(expected)) return;
      if (!ID_RE.test(item?.id || "")) continue;
      const row = await metadata(auth, item.id);
      if (row && row.inbox && row.unread && !row.excluded) rows.push(row);
    }
    const merged = new Map(retainedPriority.map(row => [row.id, row]));
    for (const row of rows) merged.set(row.id, row);
    if (!current(expected)) return;
    cache = { account: auth.account, rows: [...merged.values()], historyId: prof.historyId,
      fetchedAt: 0, nextPageToken: page.nextPageToken || null, gap };
    store.saveCache(cache);
  }
  async function syncHistory(auth, expected = generation) {
    const rows = new Map(cache.rows.map(row => [row.id, row]));
    let pending = cache.pending;
    if (!pending) {
      const changed = new Map();
      let pageToken = null, nextHistoryId = cache.historyId, pages = 0;
      do {
        if (++pages > 20) throw api.failure("too-many-pages");
        const result = await request("history", auth,
          { startHistoryId: cache.historyId, pageToken });
        if (!/^\d+$/.test(result.historyId || "") || !Array.isArray(result.history || []))
          throw api.failure("invalid-response");
        nextHistoryId = result.historyId;
        for (const record of result.history || []) {
          for (const entry of record.messagesAdded || []) {
            const id = entry?.message?.id;
            if (ID_RE.test(id || "")) changed.set(id, "added");
          }
          for (const key of ["labelsAdded", "labelsRemoved"]) {
            for (const entry of record[key] || []) {
              const id = entry?.message?.id;
              if (ID_RE.test(id || "") && changed.get(id) !== "added") changed.set(id, "changed");
            }
          }
          for (const entry of record.messagesDeleted || []) {
            const id = entry?.message?.id;
            if (ID_RE.test(id || "")) changed.set(id, "deleted");
          }
        }
        if (changed.size > 5000) throw api.failure("too-many-changes");
        pageToken = result.nextPageToken || null;
      } while (pageToken);
      pending = { historyId: nextHistoryId, changes: [...changed] };
    }
    let processed = 0;
    let nextAt = null;
    while (pending.changes.length && processed < 75) {
      if (!current(expected)) return null;
      const [id, mode] = pending.changes[0];
      if (mode === "deleted") { rows.delete(id); pending.changes.shift(); processed++; continue; }
      let row;
      try { row = await metadata(auth, id); }
      catch (error) {
        if (error.code === "minute-limit") { nextAt = error.nextAt; break; }
        if (error.code !== "not-found") throw error;
        rows.delete(id); pending.changes.shift(); processed++; continue;
      }
      if (accept(row, mode)) rows.set(id, row);
      else rows.delete(id);
      pending.changes.shift(); processed++;
    }
    if (rows.size > 5000) throw api.failure("cache-limit");
    if (!current(expected)) return null;
    cache = { ...cache, rows: [...rows.values()].sort((a, b) => b.receivedAt - a.receivedAt),
      historyId: pending.changes.length ? cache.historyId : pending.historyId,
      pending: pending.changes.length ? pending : null,
      fetchedAt: pending.changes.length ? cache.fetchedAt : now() };
    store.saveCache(cache);
    return nextAt;
  }
  function schedule() {
    if (!timer) timer = setInterval(() => {
      if (!disposed && store?.client && connectedAccount
        && (cache?.pending || !cache?.fetchedAt || now() - cache.fetchedAt >= AUTO_MS))
        void refresh(false);
    }, 60000);
  }
  function start() {
    if (disposed || setupError) return project("storage-error");
    if (!store.client) return project("config-needed");
    if (!store.secure()) return project("secure-storage-unavailable");
    let auth;
    try { settings = store.readSettings(); auth = store.readAuth();
      cache = auth ? store.readCache(auth.account) : null; }
    catch { return project("storage-error"); }
    connectedAccount = auth?.account || null;
    if (!auth) return project("unlinked");
    project(cache ? "ready" : "loading");
    schedule();
    if (!cache || !cache.fetchedAt || now() - cache.fetchedAt >= AUTO_MS) void refresh(false);
    return snapshot();
  }
  function failureState(error) {
    const code = error?.code || "failed";
    const status = code === "auth-expired" ? "auth-expired"
      : code === "google-quota" ? "quota-paused"
        : ["local-limit", "minute-limit"].includes(code) ? "local-limit"
          : code === "storage-error" ? "storage-error" : "failed";
    if (["google-quota", "gmail-api-failed", "failed"].includes(code)) {
      failures++;
      retryAt = Math.max(error?.nextAt || 0, now() + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6)));
    }
    return project(status, code, error?.nextAt || retryAt || null);
  }
  async function refresh(manual = false) {
    return queue(async () => {
      if (disposed || setupError || !store?.client || !store.secure()) return snapshot();
      const at = now(), interval = manual || cache?.pending ? MANUAL_MS : AUTO_MS;
      if (retryAt > at) return project(state.status, state.reason, retryAt);
      if (lastAttemptAt && at - lastAttemptAt < interval)
        return project(state.status, "interval", lastAttemptAt + interval);
      let auth;
      try { auth = store.readAuth(); } catch { return project("storage-error"); }
      if (!auth) return project("unlinked");
      const currentGeneration = generation;
      lastAttemptAt = at;
      project("loading");
      try {
        if (!cache) await bootstrap(auth, null, false, currentGeneration);
        if (disposed || currentGeneration !== generation) return snapshot();
        let nextAt;
        try { nextAt = await syncHistory(auth, currentGeneration); }
        catch (error) {
          if (error.code !== "not-found") throw error;
          // Expired history cannot prove whether previously read priority mail was missed.
          await bootstrap(auth, null, true, currentGeneration);
          if (!current(currentGeneration)) return snapshot();
          nextAt = await syncHistory(auth, currentGeneration);
        }
        if (disposed || currentGeneration !== generation) return snapshot();
        failures = 0; retryAt = 0;
        return project(cache.gap || cache.pending ? "partial" : "ready", null, nextAt);
      } catch (error) { return current(currentGeneration) ? failureState(error) : snapshot(); }
    });
  }
  async function loadMore() {
    return queue(async () => {
      if (!cache?.nextPageToken) return snapshot();
      const expected = generation;
      let auth;
      try { auth = store.readAuth(); } catch { return project("storage-error"); }
      if (!auth) return project("unlinked");
      project("loading");
      try {
        const page = await request("listUnread", auth, { pageToken: cache.nextPageToken });
        const rows = new Map(cache.rows.map(row => [row.id, row]));
        for (const item of page.messages || []) {
          if (!current(expected)) return snapshot();
          if (!ID_RE.test(item?.id || "") || rows.has(item.id)) continue;
          const row = await metadata(auth, item.id);
          if (row?.inbox && row.unread && !row.excluded) rows.set(row.id, row);
        }
        if (!current(expected)) return snapshot();
        cache = { ...cache, rows: [...rows.values()], nextPageToken: page.nextPageToken || null };
        store.saveCache(cache);
        return project(cache.gap ? "partial" : "ready");
      } catch (error) { return current(expected) ? failureState(error) : snapshot(); }
    });
  }
  async function connect() {
    return queue(async () => {
      const expected = generation;
      if (!store?.client) return project("config-needed");
      if (!store.secure()) return project("secure-storage-unavailable");
      project("authorizing");
      try {
        const token = await api.authorize({ client: store.client, shell, fetchImpl });
        if (!current(expected)) return snapshot();
        accessToken = token.accessToken; expiresAt = token.expiresAt;
        const result = await api.profile({ accessToken, fetchImpl, reserve });
        if (!current(expected)) return snapshot();
        const account = email(result.emailAddress);
        if (!account) throw api.failure("invalid-account");
        store.saveAuth(account, token.refreshToken);
        connectedAccount = account;
        settings = store.readSettings(); cache = store.readCache(account);
        generation++;
        schedule();
        lastAttemptAt = 0;
        void refresh(true);
        return project("loading");
      } catch (error) { return current(expected) ? failureState(error) : snapshot(); }
    });
  }
  function setSenders(values) {
    if (!Array.isArray(values) || values.length > MAX_SENDERS
      || values.some(value => email(value) !== value) || new Set(values).size !== values.length)
      return { ok: false, reason: "invalid-senders" };
    try { settings = { ...settings, senders: [...values] }; store.saveSettings(settings); }
    catch { return { ok: false, reason: "storage-error" }; }
    return { ok: true, ...project(state.status, state.reason, state.nextAt) };
  }
  function hide(id) {
    if (!ID_RE.test(id || "") || !cache?.rows.some(row => row.id === id))
      return { ok: false, reason: "invalid-message" };
    if (settings.hidden.length >= 5000 && !settings.hidden.includes(id))
      return { ok: false, reason: "local-limit" };
    try { settings = { ...settings, hidden: [...new Set([...settings.hidden, id])] };
      store.saveSettings(settings); }
    catch { return { ok: false, reason: "storage-error" }; }
    return { ok: true, ...project(state.status, state.reason, state.nextAt) };
  }
  async function detail(id) {
    if (!ID_RE.test(id || "") || !cache?.rows.some(row => row.id === id))
      return { ok: false, reason: "invalid-message" };
    if (bodyCache.has(id)) return { ok: true, body: bodyCache.get(id) };
    const expected = generation;
    let auth;
    try { auth = store.readAuth(); } catch { return { ok: false, reason: "storage-error" }; }
    try {
      const value = await request("message", auth, { id, format: "full" });
      if (!current(expected)) return { ok: false, reason: "disconnected" };
      const body = plainBody(value);
      if (bodyCache.size >= 10) bodyCache.delete(bodyCache.keys().next().value);
      bodyCache.set(id, body);
      return { ok: true, body };
    } catch (error) { return { ok: false, reason: error.code || "failed" }; }
  }
  function reloadClient() {
    try { if (store.readAuth()) return { ok: false, reason: "disconnect-first" };
      store.reloadClient(); return { ok: true, ...project("unlinked") }; }
    catch { return { ok: false, reason: "client-invalid" }; }
  }
  function canImportClient() {
    try { return !store.readAuth(); } catch { return false; }
  }
  function disconnect() {
    generation++;
    try { store.disconnect(); } catch { return project("storage-error"); }
    accessToken = null; expiresAt = 0; cache = null; connectedAccount = null;
    retryAt = 0; failures = 0; settings = { senders: [], hidden: [] };
    bodyCache.clear();
    return project("unlinked");
  }
  function dispose() { disposed = true; generation++; if (timer) clearInterval(timer); bodyCache.clear(); }
  function clearBody() { bodyCache.clear(); }
  return { start, refresh, loadMore, connect, setSenders, hide, detail,
    reloadClient, canImportClient, disconnect, dispose, clearBody, snapshot,
    diagnostics };
}

module.exports = { createMailRuntime, AUTO_MS, MANUAL_MS };
