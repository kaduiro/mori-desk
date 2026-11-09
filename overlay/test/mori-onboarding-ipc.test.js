"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const createBrowserWindowRuntime = require("../src/mori-browser-window");

function fixture(cliEnabled) {
  const handlers = new Map();
  const calls = [];
  class FakeWindow {
    constructor() {
      this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {}, send() {} };
      FakeWindow.last = this;
    }
    isDestroyed() { return false; }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    on() {}
    show() {}
    focus() {}
    destroy() {}
  }
  const runtime = createBrowserWindowRuntime({ BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    clipboard: { writeText: value => calls.push(["copy", value]) }, shell: {},
    getBridge: () => null, getPort: () => null, cliEnabled,
    getLoginStatus: () => ({ state: "disabled", enabled: false }),
    setLoginStartup: value => { calls.push(["login", value]); return { ok: true }; },
    installCliHook: agent => { calls.push(["hook", agent]); return { status: "ok" }; },
  });
  runtime.open();
  const win = FakeWindow.last;
  const trusted = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const forged = { sender: win.webContents, senderFrame: { url: trusted.senderFrame.url } };
  return { runtime, handlers, calls, trusted, forged };
}

test("onboarding IPC accepts only its own main frame and named CLI agents", async t => {
  const f = fixture(true); t.after(() => f.runtime.dispose());
  assert.equal((await f.handlers.get("mori:install-cli-hook")(f.forged, "codex")).reason, "untrusted-sender");
  assert.equal((await f.handlers.get("mori:install-cli-hook")(f.trusted, "other")).reason, "invalid-agent");
  assert.equal((await f.handlers.get("mori:set-login-startup")(f.trusted, "true")).ok, false);
  assert.equal((await f.handlers.get("mori:install-cli-hook")(f.trusted, "codex")).ok, true);
  assert.equal((await f.handlers.get("mori:install-cli-hook")(f.trusted, "claude-code")).ok, true);
  assert.equal((await f.handlers.get("mori:set-login-startup")(f.trusted, true)).ok, true);
  assert.deepEqual(f.calls, [["hook", "codex"], ["hook", "claude-code"], ["login", true]]);
});

test("browser-only mode cannot install a local CLI hook", async t => {
  const f = fixture(false); t.after(() => f.runtime.dispose());
  assert.equal((await f.handlers.get("mori:install-cli-hook")(f.trusted, "codex")).reason, "cli-disabled");
  assert.deepEqual(f.calls, []);
});
