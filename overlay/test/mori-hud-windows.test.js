"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createMailWindow } = require("../src/mori-mail-window");

test("Mail HUD keeps a usable window and restores resized dimensions and text scale", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-mail-hud-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  class FakeWindow {
    static last;
    constructor(options) {
      FakeWindow.last = this;
      this.options = options; this.events = {};
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = { mainFrame: { url: "" }, setWindowOpenHandler() {}, on() {},
        once: (_name, fn) => { this.loaded = fn; }, setZoomFactor: factor => { this.zoom = factor; }, send() {} };
    }
    isDestroyed() { return !!this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = bounds; this.events.move?.(); }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; this.loaded?.(); }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    focus() { this.focused = true; }
    setAlwaysOnTop(value) { this.pinned = value; }
    on(name, fn) { this.events[name] = fn; }
    close() { this.destroyed = true; this.events.closed?.(); }
    destroy() { this.close(); }
  }
  let bodyClears = 0;
  let cursor = { x: 250, y: 200 };
  const make = (getSuppressed = () => false) => createMailWindow({ BrowserWindow: FakeWindow, ipcMain,
    dialog: {}, clipboard: {}, shell: {}, dataDir,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }),
      getCursorScreenPoint: () => cursor },
    runtime: { snapshot: () => ({ account: null }), clearBody: () => { bodyClears++; } },
    getPetBounds: () => ({ x: 100, y: 100, width: 80, height: 80 }), getSuppressed });
  let hud = make();
  t.after(() => hud.dispose());
  assert.equal(hud.open().ok, true);
  const first = FakeWindow.last;
  assert.equal(first.options.resizable, true);
  assert.equal(first.options.skipTaskbar, false);
  assert.equal(first.focused, true);
  assert.equal(first.zoom, 1.25);
  assert.equal(first.options.alwaysOnTop, true);
  assert.equal(hud.autoOpenEnabled(), true);
  const trusted = { sender: first.webContents, senderFrame: first.webContents.mainFrame };
  assert.deepEqual(await handlers.get("mori-mail:zoom")({ sender: {} }, 1.5),
    { ok: false, reason: "untrusted-sender" });
  assert.equal((await handlers.get("mori-mail:zoom")(trusted, 1.5)).ok, true);
  assert.deepEqual(await handlers.get("mori-mail:pin")(trusted, "false"),
    { ok: false, reason: "invalid-pin" });
  assert.equal((await handlers.get("mori-mail:pin")(trusted, false)).ok, true);
  assert.equal(first.pinned, false);
  assert.deepEqual(await handlers.get("mori-mail:auto-open")(trusted, "false"),
    { ok: false, reason: "invalid-auto-open" });
  assert.equal((await handlers.get("mori-mail:auto-open")(trusted, false)).ok, true);
  assert.equal(hud.autoOpenEnabled(), false);
  first.bounds = { ...first.bounds, width: 550, height: 600 };
  first.events.resize(); first.events.resized();
  assert.deepEqual(await handlers.get("mori-mail:size")(trusted, "extra"),
    { ok: true, width: 640, height: 760 });
  assert.deepEqual(first.getBounds(), { x: 190, y: 100, width: 640, height: 760 });
  assert.deepEqual(await handlers.get("mori-mail:size")(trusted, "custom"),
    { ok: true, width: 550, height: 600 });
  assert.equal((await handlers.get("mori-mail:state")(trusted)).sizeMode, "custom");
  assert.equal((await handlers.get("mori-mail:resize-grip")(trusted, "start")).ok, true);
  cursor = { x: 280, y: 220 };
  assert.deepEqual(await handlers.get("mori-mail:resize-grip")(trusted, "move"),
    { ok: true, width: 580, height: 620 });
  assert.equal((await handlers.get("mori-mail:resize-grip")(trusted, "end")).ok, true);
  assert.deepEqual(await handlers.get("mori-mail:size")(trusted, "bad"),
    { ok: false, reason: "invalid-size" });
  first.close();
  assert.equal(bodyClears, 1);
  hud.dispose();
  hud = make();
  hud.open();
  assert.deepEqual(FakeWindow.last.getBounds(), { x: 190, y: 100, width: 580, height: 620 });
  assert.equal(FakeWindow.last.zoom, 1.5);
  assert.equal(FakeWindow.last.options.alwaysOnTop, false);
  assert.equal(hud.autoOpenEnabled(), false);
  assert.equal((await handlers.get("mori-mail:auto-open")({ sender: {} }, true)).reason,
    "untrusted-sender");
  hud.dispose();
  let suppressed = false;
  hud = make(() => suppressed);
  hud.open({ automatic: true });
  const beforeSuppression = FakeWindow.last;
  suppressed = true;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(beforeSuppression.destroyed, true);
  suppressed = false;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.notEqual(FakeWindow.last, beforeSuppression);
  const restored = FakeWindow.last;
  restored.close();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(FakeWindow.last, restored, "an explicit close must not reopen the HUD");
});
