"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const { parseClientConfig, installClientConfig } = require("../src/mori-calendar-client-config");
const { createCalendarStore } = require("../src/mori-calendar-store");
const { createCalendarRuntime } = require("../src/mori-calendar-runtime");
const { createCalendarSetupWindow } = require("../src/mori-calendar-setup-window");
const { buildOptions, outsideRoot } = require("../../scripts/build-calendar-org-windows");

const credentials = { installed: { client_id: "123-org.apps.googleusercontent.com",
  client_secret: "desktop-secret", redirect_uris: ["http://localhost"] } };
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
  encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() };

test("Desktop JSON import accepts only a bounded installed app and never exposes the secret in status", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-onboarding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "download.json"), dataDir = path.join(dir, "data");
  fs.writeFileSync(file, JSON.stringify(credentials));
  assert.deepEqual(parseClientConfig(fs.readFileSync(file, "utf8")),
    { clientId: credentials.installed.client_id, clientSecret: "desktop-secret" });
  assert.deepEqual(installClientConfig(file, dataDir), { ok: true });
  const store = createCalendarStore({ dataDir, safeStorage });
  assert.equal(store.clientSource, "personal");
  assert.equal(store.clientId, credentials.installed.client_id);
  const runtime = createCalendarRuntime({ dataDir, safeStorage, shell: {}, fetchImpl: () => { throw Error("network"); } });
  assert.equal(runtime.start().status, "unlinked");
  assert.equal(runtime.diagnostics().requestCount, 0);
  assert.equal(JSON.stringify(runtime.diagnostics()).includes("desktop-secret"), false);
  runtime.dispose();
  assert.throws(() => parseClientConfig(JSON.stringify({ web: credentials.installed })), /not-desktop-client/);
  assert.throws(() => parseClientConfig(JSON.stringify({ type: "service_account", ...credentials })), /not-desktop-client/);
  fs.writeFileSync(file, "x".repeat(32769));
  assert.throws(() => installClientConfig(file, dataDir), /invalid-config-file/);
  assert.equal(createCalendarStore({ dataDir, safeStorage }).clientId, credentials.installed.client_id);
});

test("managed configuration is a fallback, and new tokens refuse a different client", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-onboarding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "data"), managed = path.join(dir, "managed.json");
  fs.writeFileSync(managed, JSON.stringify(credentials));
  const first = createCalendarStore({ dataDir, managedClientFile: managed, safeStorage });
  assert.equal(first.clientSource, "managed");
  first.saveAuth("refresh-token", true);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "client.json"), JSON.stringify({ clientId: "456-other.apps.googleusercontent.com",
    clientSecret: "another-secret" }));
  const second = createCalendarStore({ dataDir, managedClientFile: managed, safeStorage });
  assert.equal(second.clientSource, "personal");
  assert.equal(second.managedDiffers, true);
  assert.throws(() => second.readAuth(), /calendar-client-changed/);
  second.recordRequest([], Date.now());
  const runtime = createCalendarRuntime({ dataDir, managedClientFile: managed, safeStorage,
    shell: {}, fetchImpl: () => { throw Error("network"); } });
  assert.equal(runtime.start().status, "config-changed");
  assert.equal(runtime.canImportClient(), false);
  assert.equal(runtime.switchToManaged().reason, "disconnect-first");
  runtime.disconnect();
  assert.equal(runtime.canImportClient(), true);
  assert.equal(runtime.diagnostics().requestCount, 1);
  assert.equal(runtime.switchToManaged().ok, true);
  assert.equal(runtime.snapshot().configSource, "managed");
  assert.equal(runtime.diagnostics().requestCount, 1);
  assert.equal(fs.existsSync(path.join(dataDir, "client.json")), false);
  runtime.dispose();
});

test("setup IPC rejects other windows and imports a selected Desktop JSON after explicit disconnection", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-onboarding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "download.json"), dataDir = path.join(dir, "data");
  fs.writeFileSync(file, JSON.stringify(credentials));
  const runtime = createCalendarRuntime({ dataDir, safeStorage, shell: {},
    fetchImpl: () => { throw Error("network"); } });
  runtime.start();
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  class FakeWindow {
    constructor() { this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {}, send() {} };
      this.webContents.mainFrame.url = pathToFileURL(path.join(__dirname, "../src/mori-calendar-setup.html")).href;
      FakeWindow.last = this; }
    isDestroyed() { return false; }
    loadFile() {}
    on() {}
    show() {}
    focus() {}
    destroy() {}
  }
  const setup = createCalendarSetupWindow({ BrowserWindow: FakeWindow, ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) }, runtime, dataDir,
    openCalendar: () => ({ ok: true }) });
  setup.open();
  const invalid = { sender: {}, senderFrame: {} };
  assert.equal((await handlers.get("mori-calendar-setup:import")(invalid)).reason, "untrusted-sender");
  const current = setup.open();
  assert.equal(current.ok, true);
  // The trusted sender is the exact window and main frame, not merely a matching URL.
  const frame = { url: pathToFileURL(path.join(__dirname, "../src/mori-calendar-setup.html")).href };
  const fakeSender = { mainFrame: frame };
  assert.equal((await handlers.get("mori-calendar-setup:state")({ sender: fakeSender, senderFrame: frame })).reason,
    "untrusted-sender");
  const trusted = { sender: FakeWindow.last.webContents, senderFrame: FakeWindow.last.webContents.mainFrame };
  assert.equal((await handlers.get("mori-calendar-setup:import")(trusted)).ok, true);
  assert.equal((await handlers.get("mori-calendar-setup:state")(trusted)).configSource, "personal");
  assert.equal(createCalendarStore({ dataDir, safeStorage }).clientId, credentials.installed.client_id);
  setup.dispose();
  runtime.dispose();
});

test("organization build keeps the OAuth file outside Git and adds it only as a packaged resource", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-calendar-build-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "org.json");
  fs.writeFileSync(file, JSON.stringify(credentials));
  const runtime = path.resolve(__dirname, "../../.runtime");
  assert.equal(outsideRoot(path.resolve(__dirname, "../src/mori-calendar-store.js")), false);
  const options = buildOptions({ runtime, clientFile: file, outputDir: path.join(dir, "dist") });
  assert.equal(options.config.extraResources.at(-1).to, "mori-calendar-client.json");
  assert.equal(options.config.extraResources.at(-1).from, file);
  assert.equal(JSON.stringify(options.config).includes("desktop-secret"), false);
});

test("first-run view advances from connection to explicit calendar choice and distinguishes zero events", async () => {
  function element() {
    return { children: [], listeners: {}, classList: { add() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, fn) { this.listeners[name] = fn; } };
  }
  const ids = Object.fromEntries(["steps", "message", "config-panel", "connect-panel", "selection-panel",
    "result-panel", "config-description", "import-config", "google-setup", "connect-description", "connect", "selection-description",
    "calendar-options", "apply-selection", "reload-calendars", "grant-scope", "result-description",
    "open-calendar", "change-selection", "config-source", "selected-count", "last-fetch", "next-refresh",
    "request-count", "source-statuses", "disconnect", "switch-config", "use-managed", "open-browser"].map(id => [id, element()]));
  ids.steps.children = Array.from({ length: 4 }, element);
  const document = { getElementById: id => ids[id], createElement: element };
  let data = { ok: true, status: "unlinked", configSource: "personal", selectedIds: ["primary"],
    events: [], calendars: [], sources: [], requestCount: 0, requestLimit: 100 };
  let onChange;
  const window = { confirm: () => true, moriCalendarSetup: {
    state: async () => data, onChange: fn => { onChange = fn; },
    select: async ids => { data = { ...data, selectedIds: ids, selectionConfirmed: true,
      status: "ready", fetchedAt: Date.now() }; return { ok: true }; },
  } };
  const source = fs.readFileSync(path.join(__dirname, "../src/mori-calendar-setup-renderer.js"), "utf8");
  vm.runInNewContext(source, { window, document, Date, Intl });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ids["connect-panel"].hidden, false);
  data = { ...data, status: "ready", listScope: true, selectionConfirmed: false,
    calendars: [{ id: "primary", name: "本人", readable: true },
      { id: "shared", name: "共有", readable: true }] };
  await onChange();
  assert.equal(ids["selection-panel"].hidden, false);
  assert.match(ids["selection-description"].textContent, /選択中: 1\/3/);
  const shared = ids["calendar-options"].children[1].children[0];
  shared.checked = true; shared.listeners.change();
  assert.match(ids["selection-description"].textContent, /選択中: 2\/3/);
  await ids["apply-selection"].listeners.click();
  assert.equal(ids["result-panel"].hidden, false);
  assert.match(ids["result-description"].textContent, /今日の予定は 0 件/);
});
