"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const core = require("../src/mori-calendar-core");
const { createCalendarStore } = require("../src/mori-calendar-store");
const { authorize, refreshToken, listToday, listCalendars, SCOPE, LIST_SCOPE } = require("../src/mori-calendar-api");
const { createCalendarRuntime } = require("../src/mori-calendar-runtime");
const { createCalendarWindow } = require("../src/mori-calendar-window");

test("collapsed calendar rows show the start and end time beside each title", async () => {
  function element() {
    return { children: [], listeners: {}, classList: { add() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, listener) { this.listeners[name] = listener; } };
  }
  const ids = Object.fromEntries(["date", "state", "updated", "source-status", "usage", "calendar-notify", "calendar-quiet-start", "calendar-quiet-end", "notification-status", "events", "selection", "selection-note",
    "calendar-options", "apply-selection", "reload-calendars", "choose", "connect", "disconnect", "refresh", "close", "setup", "text-size", "window-size", "resize-grip", "pin", "auto-open"]
    .map(id => [id, element()]));
  const document = { getElementById: id => ids[id], createElement: element,
    querySelectorAll: () => [] };
  const events = [
    { id: "same-day", title: "午前の予定", sourceName: "共有A", start: "2026-11-02T09:00:00", end: "2026-11-02T10:30:00", allDay: false },
    { id: "overnight", title: "夜勤", start: "2026-11-02T23:00:00", end: "2026-11-03T01:00:00", allDay: false },
    { id: "all-day", title: "休日", start: "2026-11-02", end: "2026-11-03", allDay: true },
  ];
  const window = { moriCalendar: { state: async () => ({ ok: true, date: "2026-11-02", status: "ready", events,
    selectedIds: ["primary", "shared", "holiday"], listScope: true, listStatus: "ready",
    calendars: [{ id: "primary", name: "本人", readable: true },
      { id: "shared", name: "共有", readable: true },
      { id: "holiday", name: "祝日", readable: true },
      { id: "other", name: "別の共有", readable: true }] }),
    onChange() {}, close() {}, connect() {}, refresh() {}, disconnect() {}, openSetup() {} } };
  const script = fs.readFileSync(path.join(__dirname, "../src/mori-calendar-renderer.js"), "utf8");
  vm.runInNewContext(script, { document, window, Intl, Date });
  await new Promise(resolve => setImmediate(resolve));
  const rows = ids.events.children;
  assert.deepEqual(rows.map(row => row.open), [false, false, false]);
  assert.deepEqual(rows.map(row => row.children[0].children[1].textContent),
    ["09:00–10:30", "11/2 23:00–11/3 01:00", "終日"]);
  assert.equal(rows[0].children[0].children[0].textContent, "午前の予定");
  assert.equal(rows[0].children[0].children[2].textContent, "共有A");
  ids.choose.listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ids.selection.hidden, false);
  const options = ids["calendar-options"].children;
  assert.deepEqual(options.map(row => row.children[1].textContent), ["本人", "共有", "祝日", "別の共有"]);
  assert.match(ids["selection-note"].textContent, /選択中: 3\/3。最大3件/);
  options[3].children[0].checked = true;
  options[3].children[0].listeners.change();
  assert.equal(options[3].children[0].checked, false);
  assert.match(ids["selection-note"].textContent, /選択済みのチェックを1つ外してください/);
  options[2].children[0].checked = false;
  options[2].children[0].listeners.change();
  assert.match(ids["selection-note"].textContent, /選択中: 2\/3/);
  options[3].children[0].checked = true;
  options[3].children[0].listeners.change();
  assert.equal(options[3].children[0].checked, true);
  assert.match(ids["selection-note"].textContent, /選択中: 3\/3/);
});

test("day bounds use local midnights and event normalization keeps all-day, ongoing and declined entries", () => {
  const bounds = core.dayBounds(new Date(2026, 10, 1, 9));
  assert.equal(bounds.key, "2026-11-01");
  assert.equal(new Date(bounds.start).getHours(), 0);
  assert.equal(new Date(bounds.end).getDate(), 2);
  const rows = core.normalizeEvents([
    { id: "x", status: "cancelled", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } },
    { summary: "ID 不明", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } },
    { id: "timed", summary: "会議", start: { dateTime: "2026-11-01T10:00:00+09:00" },
      end: { dateTime: "2026-11-01T11:00:00+09:00" },
      attendees: [{ self: true, responseStatus: "declined" }] },
    { id: "all", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } },
  ]);
  assert.deepEqual(rows.map(row => row.id), ["all", "timed"]);
  assert.equal(rows[0].allDay, true);
  assert.equal(rows[0].title, "無題の予定");
  assert.equal(rows[1].declined, true);
});

test("meeting URL wins over calendar link and unsafe URLs are rejected", () => {
  assert.deepEqual(core.eventLink({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc" }] },
    htmlLink: "https://calendar.google.com/event" }), { url: "https://meet.google.com/abc", kind: "join" });
  assert.equal(core.eventLink({ hangoutLink: "javascript:alert(1)", htmlLink: "https://calendar.google.com/event" }).kind, "event");
  assert.equal(core.safeHttps("https://user:pass@example.com/path"), null);
  assert.equal(core.safeHttps("file:///secret"), null);
});

test("events with different UTC offsets are sorted by actual start time", () => {
  const items = [
    { id: "late", start: { dateTime: "2026-11-02T10:00:00+09:00" },
      end: { dateTime: "2026-11-02T11:00:00+09:00" } },
    { id: "early", start: { dateTime: "2026-11-01T23:30:00-03:00" },
      end: { dateTime: "2026-11-02T00:30:00-03:00" } },
  ];
  assert.deepEqual(core.normalizeEvents(items).map(item => item.id), ["late", "early"]);
});

test("request allowance enforces interval and rolling daily limit", () => {
  const now = Date.now();
  assert.equal(core.requestAllowance([now - 1000], now).reason, "interval");
  assert.equal(core.requestAllowance([now - 1000], now, true).reason, "interval");
  assert.equal(core.requestAllowance(Array.from({ length: 100 }, (_, i) => now - 1000000 + i), now).reason, "local_limit");
  assert.equal(core.requestAllowance([now - core.DAY_MS - 1], now).allowed, true);
});

test("list pages, failed sends, and event pages share a durable 100-request pre-send gate", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-ledger-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value), decryptString: value => value.toString().slice(7) };
  const store = createCalendarStore({ dataDir, safeStorage });
  const base = Date.now();
  assert.equal(store.reserveRequest(base, "list", { manual: false }).allowed, true);
  // The request is counted even when its HTTP response fails.
  assert.equal(store.reserveRequest(base + 1, "list", { manual: null }).allowed, true);
  assert.equal(store.reserveRequest(base + 2, "list", { manual: false }).reason, "interval");
  assert.equal(store.reserveRequest(base + 3, "event", { manual: false, selectedCount: 3 }).allowed, true);
  for (let i = 4; i <= 100; i++)
    assert.equal(store.reserveRequest(base + i, "event", { manual: null }).allowed, true);
  const restarted = createCalendarStore({ dataDir, safeStorage });
  assert.equal(restarted.ledger().times.length, 100);
  assert.equal(restarted.reserveRequest(base + 101, "event", { manual: null }).reason, "local-limit");
  assert.equal(restarted.ledger().eventCycleAt, base + 3);
  assert.equal(restarted.ledger().listAttemptAt, base);
});

test("store seals tokens, persists request ledger, and removes owned auth files on disconnect", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "client.json"), JSON.stringify({
    clientId: "123-test.apps.googleusercontent.com", clientSecret: "desktop-secret",
  }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value), decryptString: value => value.toString().slice(7) };
  const store = createCalendarStore({ dataDir, safeStorage });
  assert.equal(store.clientSecret, "desktop-secret");
  store.saveToken("refresh-secret");
  assert.equal(store.readToken(), "refresh-secret");
  assert.equal(fs.readFileSync(path.join(dataDir, "auth.json"), "utf8").includes("refresh-secret"), false);
  store.recordRequest([], 1234);
  assert.deepEqual(store.ledger().times, [1234]);
  store.disconnect();
  assert.equal(fs.existsSync(path.join(dataDir, "auth.json")), false);
});

test("Calendar API counts every page and returns only normalized fields", async () => {
  let requests = 0;
  const fetchImpl = async url => {
    const page = new URL(url).searchParams.get("pageToken");
    return new Response(JSON.stringify(page
      ? { items: [{ id: "b", summary: "二件目", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }] }
      : { items: [{ id: "a", summary: "一件目", start: { date: "2026-11-01" }, end: { date: "2026-11-02" }, attendees: [{ email: "secret@example.com" }] }], nextPageToken: "next" }), { status: 200 });
  };
  const result = await listToday({ accessToken: "access", requestPage: () => { requests++; }, fetchImpl, now: new Date(2026, 10, 1) });
  assert.equal(requests, 2);
  assert.equal(result.events.length, 2);
  assert.equal("attendees" in result.events[0], false);
});

test("desktop OAuth rejects a wrong state and exchanges a PKCE verifier on loopback", async () => {
  let authorizationUrl;
  const shell = { openExternal: async value => {
    authorizationUrl = new URL(value);
    const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri"));
    assert.equal(redirect.hostname, "127.0.0.1");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    redirect.searchParams.set("state", "wrong");
    redirect.searchParams.set("code", "bad");
    assert.equal((await fetch(redirect)).status, 400);
    redirect.searchParams.set("state", authorizationUrl.searchParams.get("state"));
    redirect.searchParams.set("code", "good");
    assert.equal((await fetch(redirect)).status, 200);
  } };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const form = options.body;
    assert.equal(form.get("code"), "good");
    assert.equal(form.get("client_id"), "123-test.apps.googleusercontent.com");
    assert.equal(form.get("client_secret"), "desktop-secret");
    const challenge = require("node:crypto").createHash("sha256")
      .update(form.get("code_verifier")).digest("base64url");
    assert.equal(challenge, authorizationUrl.searchParams.get("code_challenge"));
    assert.equal(form.get("redirect_uri"), authorizationUrl.searchParams.get("redirect_uri"));
    return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh",
      expires_in: 3600, scope: SCOPE }), { status: 200 });
  };
  const result = await authorize({ clientId: "123-test.apps.googleusercontent.com",
    clientSecret: "desktop-secret", shell, fetchImpl });
  assert.equal(result.refreshToken, "refresh");
  assert.equal(authorizationUrl.searchParams.get("scope").includes(LIST_SCOPE), true);
  assert.equal(result.listScope, false);
});

test("CalendarList pages count and only readable entries can be selected", async () => {
  let pages = 0;
  const result = await listCalendars({ accessToken: "access", requestPage: () => { pages++; },
    fetchImpl: async url => new Response(JSON.stringify(new URL(url).searchParams.has("pageToken")
      ? { items: [{ id: "shared@example.com", summary: "共有", accessRole: "reader" }] }
      : { items: [{ id: "owner@example.com", summary: "本人", primary: true, accessRole: "owner" },
        { id: "busy@example.com", summary: "空き時間のみ", accessRole: "freeBusyReader" }],
      nextPageToken: "next" }), { status: 200 }) });
  assert.equal(pages, 2);
  assert.deepEqual(result.map(item => item.readable), [true, false, true]);
});

test("three selected calendars share a durable request ledger and use a 60-minute auto cycle", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-multi-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "client.json"), JSON.stringify({ clientId: "123-test.apps.googleusercontent.com" }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value), decryptString: value => value.toString().slice(7) };
  const setup = createCalendarStore({ dataDir, safeStorage });
  const generation = setup.saveAuth("refresh-secret", true);
  const calendars = [
    { id: "primary", name: "本人", readable: true },
    { id: "shared@example.com", name: "共有", readable: true },
    { id: "third@example.com", name: "第3", readable: true },
  ];
  setup.saveCalendars(generation, calendars);
  setup.saveSelection(generation, calendars.map(item => item.id));
  let clock = Date.now(), calls = [];
  const fetchImpl = async url => {
    if (url.startsWith("https://oauth2.googleapis.com/"))
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    calls.push(url);
    if (url.includes("/calendarList"))
      return new Response(JSON.stringify({ items: calendars.map(item => ({
        id: item.id, summary: item.name, primary: item.id === "primary", accessRole: "reader",
      })) }), { status: 200 });
    const id = decodeURIComponent(new URL(url).pathname.split("/")[4]);
    return new Response(JSON.stringify({ items: [{ id: "same-id", summary: id,
      start: { dateTime: "2026-11-02T09:00:00+09:00" },
      end: { dateTime: "2026-11-02T10:00:00+09:00" } }] }), { status: 200 });
  };
  const runtime = createCalendarRuntime({ dataDir, safeStorage, shell: {}, fetchImpl, now: () => clock });
  t.after(() => runtime.dispose());
  runtime.start();
  await runtime.loadCalendars(false);
  assert.equal(calls.length, 4);
  assert.equal(runtime.snapshot().events.length, 3);
  assert.equal(new Set(runtime.snapshot().events.map(item => item.key)).size, 3);
  assert.deepEqual(runtime.snapshot().events.map(item => item.sourceName).sort(), ["本人", "共有", "第3"].sort());
  assert.equal(createCalendarStore({ dataDir, safeStorage }).ledger().times.length, 4);
  clock += 59 * 60 * 1000;
  await runtime.refresh(false);
  assert.equal(calls.length, 4);
  clock += 60 * 1000 + 1;
  await runtime.refresh(false);
  assert.equal(calls.length, 7);
  assert.equal(createCalendarStore({ dataDir, safeStorage }).ledger().times.length, 7);
  runtime.dispose();
});

test("partial source failure is distinct from an empty day and old account cache is isolated", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-partial-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "client.json"), JSON.stringify({ clientId: "123-test.apps.googleusercontent.com" }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value), decryptString: value => value.toString().slice(7) };
  const setup = createCalendarStore({ dataDir, safeStorage });
  const old = setup.saveAuth("old", true);
  setup.saveSources(core.dayBounds(new Date()).key, old, { primary: { events: [{ id: "old", title: "old" }], fetchedAt: Date.now() } });
  const current = setup.saveAuth("new", true);
  assert.equal(setup.readCache(core.dayBounds(new Date()).key, current), null);
  setup.saveSelection(current, ["primary", "shared@example.com"]);
  setup.saveCalendars(current, [{ id: "primary", name: "本人", readable: true },
    { id: "shared@example.com", name: "共有", readable: true }]);
  let calls = 0;
  const fetchImpl = async url => {
    if (url.startsWith("https://oauth2.googleapis.com/"))
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    calls++;
    if (url.includes("shared%40example.com"))
      return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 });
    if (url.includes("calendarList"))
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  const runtime = createCalendarRuntime({ dataDir, safeStorage, shell: {}, fetchImpl });
  runtime.start();
  await runtime.loadCalendars(false);
  const state = runtime.snapshot();
  assert.equal(state.status, "partial");
  assert.equal(state.events.length, 0);
  assert.equal(state.sources.find(item => item.id === "shared@example.com").status, "permission-denied");
  assert.equal(calls, 3);
  runtime.dispose();
});

test("desktop OAuth sends the configured secret when refreshing a token", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(options.body.get("client_secret"), "desktop-secret");
    assert.equal(options.body.get("refresh_token"), "saved-token");
    return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
  };
  const result = await refreshToken("123-test.apps.googleusercontent.com", "desktop-secret",
    "saved-token", fetchImpl);
  assert.equal(result.accessToken, "access");
});

test("unconfigured runtime reports config-needed without contacting Google", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-test-"));
  try {
    const runtime = createCalendarRuntime({ dataDir, safeStorage: {}, shell: {}, fetchImpl: () => { throw Error("unexpected"); } });
    assert.equal(runtime.start().status, "config-needed");
    runtime.dispose();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("runtime enforces auto interval and persists a Google quota pause across restart", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "client.json"), JSON.stringify({ clientId: "123-test.apps.googleusercontent.com" }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value), decryptString: value => value.toString().slice(7) };
  createCalendarStore({ dataDir, safeStorage }).saveToken("refresh-secret");
  let clock = Date.now(), calls = 0, quota = false;
  const fetchImpl = async url => {
    if (url.startsWith("https://oauth2.googleapis.com/")) return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    calls++;
    return quota
      ? new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), { status: 429 })
      : new Response(JSON.stringify({ items: [{ id: "one", summary: "朝会",
        start: { dateTime: "2026-11-01T09:00:00+09:00" }, end: { dateTime: "2026-11-01T09:30:00+09:00" } }] }), { status: 200 });
  };
  const runtime = createCalendarRuntime({ dataDir, safeStorage, shell: {}, fetchImpl, now: () => clock });
  runtime.start();
  await runtime.refresh();
  assert.equal(runtime.snapshot().status, "ready");
  assert.equal(calls, 1);
  await runtime.refresh();
  assert.equal(calls, 1);
  quota = true; clock += core.AUTO_INTERVAL_MS + 1;
  assert.equal((await runtime.refresh()).status, "quota-paused");
  assert.equal(calls, 2);
  runtime.dispose();
  const restarted = createCalendarRuntime({ dataDir, safeStorage, shell: {}, fetchImpl, now: () => clock });
  restarted.start();
  await restarted.refresh();
  assert.equal(restarted.snapshot().status, "quota-paused");
  assert.equal(calls, 2);
  restarted.dispose();
});

test("automatic calendar card honors suppression while manual open remains available", () => {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = { setWindowOpenHandler() {}, on() {}, once() {}, send() {} };
      this.events = {};
      FakeWindow.created++;
    }
    isDestroyed() { return false; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    loadFile() {}
    showInactive() {}
    on(name, fn) { this.events[name] = fn; }
    close() { this.events.closed?.(); }
    destroy() { this.close(); }
  }
  FakeWindow.created = 0;
  const calendar = createCalendarWindow({
    BrowserWindow: FakeWindow, ipcMain, shell: {},
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
    runtime: { snapshot: () => ({ events: [] }), connect() {}, refresh() {}, disconnect() {} },
    getPetBounds: () => ({ x: 100, y: 100, width: 80, height: 80 }), getSuppressed: () => true,
  });
  assert.equal(calendar.open({ automatic: true }).reason, "suppressed");
  assert.equal(FakeWindow.created, 0);
  assert.equal(calendar.open().ok, true);
  assert.equal(FakeWindow.created, 1);
  calendar.dispose();
  assert.equal(handlers.size, 0);
});

test("calendar card can be dragged without snapping back and restores its saved position", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-layout-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const handlers = new Map();
  class FakeWindow {
    static last;
    constructor(options) {
      this.options = options;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.events = {};
      this.webContents = { mainFrame: { url: "" }, setWindowOpenHandler() {}, on() {},
        once: (_name, fn) => { this.loaded = fn; }, send() {} };
      FakeWindow.last = this;
    }
    isDestroyed() { return false; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; this.events.move?.(); }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; this.loaded?.(); }
    showInactive() {}
    show() {}
    focus() {}
    on(name, fn) { this.events[name] = fn; }
    close() { this.events.closed?.(); }
    destroy() { this.close(); }
  }
  let cursor = { x: 300, y: 300 };
  const make = () => createCalendarWindow({
    BrowserWindow: FakeWindow, ipcMain: { handle: (name, fn) => handlers.set(name, fn),
      removeHandler: name => handlers.delete(name) }, shell: {}, dataDir,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getCursorScreenPoint: () => cursor },
    runtime: { snapshot: () => ({ events: [] }), connect() {}, refresh() {}, disconnect() {} },
    getPetBounds: () => ({ x: 100, y: 100, width: 80, height: 80 }), getSuppressed: () => false,
  });
  let calendar, restarted;
  t.after(() => { calendar?.dispose(); restarted?.dispose(); });
  calendar = make();
  calendar.open();
  const first = FakeWindow.last;
  assert.equal(calendar.autoOpenEnabled(), true);
  const trusted = { sender: first.webContents, senderFrame: first.webContents.mainFrame };
  assert.deepEqual(await handlers.get("mori-calendar:auto-open")(trusted, "false"),
    { ok: false, reason: "invalid-auto-open" });
  assert.equal((await handlers.get("mori-calendar:auto-open")(trusted, false)).ok, true);
  assert.equal(calendar.autoOpenEnabled(), false);
  assert.equal(first.options.transparent, true);
  assert.deepEqual(first.getBounds(), { x: 190, y: 100, width: 400, height: 480 });
  first.bounds = { ...first.bounds, x: 260, y: 220 };
  first.events.move();
  first.events.moved();
  calendar.open();
  assert.deepEqual(first.getBounds(), { x: 260, y: 220, width: 400, height: 480 });
  first.bounds = { ...first.bounds, width: 455, height: 530 };
  first.events.resize(); first.events.resized();
  assert.deepEqual(await handlers.get("mori-calendar:size")(trusted, "unknown"),
    { ok: false, reason: "invalid-size" });
  assert.deepEqual(await handlers.get("mori-calendar:size")({ sender: {} }, "large"),
    { ok: false, reason: "untrusted-sender" });
  assert.deepEqual(await handlers.get("mori-calendar:size")(trusted, "large"),
    { ok: true, width: 520, height: 620 });
  assert.deepEqual(first.getBounds(), { x: 260, y: 180, width: 520, height: 620 });
  assert.deepEqual(await handlers.get("mori-calendar:size")(trusted, "custom"),
    { ok: true, width: 455, height: 530 });
  assert.equal((await handlers.get("mori-calendar:state")(trusted)).sizeMode, "custom");
  assert.deepEqual(await handlers.get("mori-calendar:resize-grip")(trusted, "move"),
    { ok: false, reason: "resize-not-started" });
  assert.equal((await handlers.get("mori-calendar:resize-grip")(trusted, "start")).ok, true);
  cursor = { x: 350, y: 340 };
  assert.deepEqual(await handlers.get("mori-calendar:resize-grip")(trusted, "move"),
    { ok: true, width: 505, height: 570 });
  assert.equal((await handlers.get("mori-calendar:resize-grip")(trusted, "end")).ok, true);
  first.close();
  calendar.open();
  assert.deepEqual(FakeWindow.last.getBounds(), { x: 260, y: 180, width: 505, height: 570 });
  calendar.dispose();
  restarted = make();
  restarted.open();
  assert.deepEqual(FakeWindow.last.getBounds(), { x: 260, y: 180, width: 505, height: 570 });
  assert.equal(restarted.autoOpenEnabled(), false);
  assert.equal((await handlers.get("mori-calendar:auto-open")({ sender: {} }, true)).reason,
    "untrusted-sender");
  restarted.dispose();
});

test("disconnect during an in-flight fetch does not restore events or cache", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, "client.json"), JSON.stringify({ clientId: "123-test.apps.googleusercontent.com" }));
  const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value), decryptString: value => value.toString().slice(7) };
  createCalendarStore({ dataDir, safeStorage }).saveToken("refresh-secret");
  let finishFetch, fetchStarted;
  const started = new Promise(resolve => { fetchStarted = resolve; });
  const fetchImpl = async url => {
    if (url.startsWith("https://oauth2.googleapis.com/"))
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    fetchStarted();
    return new Promise(resolve => { finishFetch = () => resolve(new Response(JSON.stringify({
      items: [{ id: "one", summary: "会議", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }],
    }), { status: 200 })); });
  };
  const runtime = createCalendarRuntime({ dataDir, safeStorage, shell: {}, fetchImpl });
  const pending = runtime.refresh();
  await started;
  runtime.disconnect();
  finishFetch();
  await pending;
  assert.equal(runtime.snapshot().status, "unlinked");
  assert.deepEqual(runtime.snapshot().events, []);
  assert.equal(fs.existsSync(path.join(dataDir, "cache.json")), false);
  runtime.dispose();
});
