"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createGoogleSetupWindow, ALLOWED_URLS } = require("../src/mori-google-setup-window");

test("personal Cloud guide keeps navigation local and stores only a user-reported project check", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-google-guide-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const opened = [];
  const handlers = new Map();
  const ipcMain = { handle: (key, fn) => handlers.set(key, fn),
    removeHandler: key => handlers.delete(key) };
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = {
        mainFrame: { url: "" },
        setWindowOpenHandler: handler => { this.popup = handler; },
        on: (name, handler) => { this[name] = handler; },
      };
      FakeWindow.last = this;
    }
    isDestroyed() { return !!this.destroyed; }
    loadFile(file) { this.file = file; this.webContents.mainFrame.url = pathToFileURL(file).href; }
    on(name, handler) { this[name] = handler; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; }
  }
  const guide = createGoogleSetupWindow({ BrowserWindow: FakeWindow, ipcMain, dataDir,
    shell: { openExternal: url => { opened.push(url); } } });
  assert.deepEqual(guide.open(), { ok: true });
  const win = FakeWindow.last;
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.match(win.file, /mori-google-setup\.html$/);
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  win["will-navigate"](nav);
  assert.equal(nav.prevented, true);
  for (const url of ALLOWED_URLS) assert.deepEqual(win.popup({ url }), { action: "deny" });
  assert.deepEqual(opened, [...ALLOWED_URLS]);
  for (const url of ["https://evil.example/", "javascript:alert(1)",
    "https://console.cloud.google.com.evil.example/", "file:///C:/secret.txt"]) {
    assert.deepEqual(win.popup({ url }), { action: "deny" });
  }
  assert.equal(opened.length, ALLOWED_URLS.size);
  const trusted = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal((await handlers.get("mori-google-setup:state")({ sender: {} })).reason, "untrusted-sender");
  assert.equal((await handlers.get("mori-google-setup:state")(trusted)).source, "unconfirmed");
  assert.equal((await handlers.get("mori-google-setup:save")(trusted,
    { projectId: "bad", billing: "linked", gmailQuotaChecked: true,
      calendarQuotaChecked: true })).ok, false);
  const saved = await handlers.get("mori-google-setup:save")(trusted,
    { projectId: "mori-personal-123", billing: "not-linked", gmailQuotaChecked: true,
      calendarQuotaChecked: false });
  assert.equal(saved.ok, true);
  assert.equal(saved.source, "self-reported-cloud-console");
  assert.equal(saved.billing, "not-linked");
  assert.equal(Number.isSafeInteger(saved.checkedAt), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, "status.json"), "utf8"))).sort(),
    ["billing", "calendarQuota", "calendarQuotaChecked", "checkedAt", "gmailQuota", "gmailQuotaChecked", "projectId", "source", "version"]);
  const observed = await handlers.get("mori-google-setup:save")(trusted,
    { projectId: "mori-personal-123", billing: "not-linked", gmailQuotaChecked: true,
      calendarQuotaChecked: true, gmailQuota: { metric: "units per minute", used: 100, limit: 1000, window: "minute" },
      calendarQuota: { metric: "requests per day", used: 5, limit: 100, window: "day" } });
  assert.equal(observed.gmailQuota.used, 100);
  assert.equal(observed.calendarQuota.window, "day");
  assert.equal((await handlers.get("mori-google-setup:save")(trusted,
    { ...observed, gmailQuota: { used: -1, limit: 100, window: "minute" } })).ok, false);
  guide.dispose();
  assert.equal(win.destroyed, true);
  assert.equal(handlers.size, 0);
});
