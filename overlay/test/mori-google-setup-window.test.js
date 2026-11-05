"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoogleSetupWindow, ALLOWED_URLS } = require("../src/mori-google-setup-window");

test("personal Cloud guide keeps navigation local and opens only fixed official links", () => {
  const opened = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.webContents = {
        setWindowOpenHandler: handler => { this.popup = handler; },
        on: (name, handler) => { this[name] = handler; },
      };
      FakeWindow.last = this;
    }
    isDestroyed() { return !!this.destroyed; }
    loadFile(file) { this.file = file; }
    on(name, handler) { this[name] = handler; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
    destroy() { this.destroyed = true; }
  }
  const guide = createGoogleSetupWindow({ BrowserWindow: FakeWindow,
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
  guide.dispose();
  assert.equal(win.destroyed, true);
});
