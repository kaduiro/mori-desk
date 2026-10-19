"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const createSettingsWindowRuntime = require("../src/settings-window");

const SRC = path.join(__dirname, "..", "src");

function loadSettingsCore({ platform = "Win32", moriCliEnabled = false } = {}) {
  const toasts = [];
  const durations = [];
  const context = {
    console,
    navigator: { platform },
    settingsAPI: { moriCliEnabled },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      body: { contains: () => false },
      getElementById: id => id === "toastStack" ? { appendChild: node => toasts.push(node) } : null,
      createElement: () => ({ textContent: "", className: "", classList: { add() {}, remove() {} } }),
    },
    requestAnimationFrame: callback => { callback(); return 1; },
    setTimeout: (_callback, duration) => { durations.push(duration); return 1; },
    ClawdSettingsSizeSlider: { createSizeSliderController: () => ({}) },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["shortcut-actions.js", "settings-i18n.js", "settings-ui-core.js"]) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), "utf8"), context, { filename: file });
  }
  return { core: context.ClawdSettingsCore, toasts, durations };
}

function snapshot(lang = "ja", accelerator = "CommandOrControl+Shift+Alt+C") {
  return { lang, shortcuts: { togglePet: accelerator } };
}

test("an early startup shortcut failure waits for Japanese preferences and names the actual binding", () => {
  const { core, toasts, durations } = loadSettingsCore();
  core.state.activeTab = "theme";
  core.ops.applyShortcutFailures({ togglePet: "system conflict" });
  assert.equal(toasts.length, 0);
  core.ops.applyBootstrap(snapshot());
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].textContent, /ショートカットを使用できません/);
  assert.match(toasts[0].textContent, /ペット/);
  assert.match(toasts[0].textContent, /Ctrl\+Shift\+Alt\+C/);
  assert.match(toasts[0].textContent, /設定 → ショートカット/);
  assert.match(toasts[0].textContent, /解除/);
  assert.doesNotMatch(toasts[0].textContent, /Saved|保存しました|ダッシュボード/);
  assert.deepEqual(durations, [8000]);
  assert.equal(core.state.activeTab, "theme");
  core.ops.applyShortcutFailures({ togglePet: "system conflict" });
  assert.equal(toasts.length, 1);
});

test("a failure that arrives after preferences uses the saved language and macOS key names", () => {
  const { core, toasts } = loadSettingsCore({ platform: "MacIntel" });
  core.ops.applyBootstrap(snapshot("en", "Control+Shift+1"));
  assert.equal(toasts.length, 0);
  core.ops.applyShortcutFailures({ togglePet: "system conflict" });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].textContent, /Shortcut unavailable: Toggle pet visibility \(⌃⇧1\)/);
  assert.match(toasts[0].textContent, /Settings → Shortcuts/);
});

test("a cleared startup failure or an unsupported action does not show a stale warning", () => {
  const { core, toasts } = loadSettingsCore({ platform: "Linux x86_64" });
  core.ops.applyShortcutFailures({ togglePet: "system conflict" });
  core.ops.applyShortcutFailures({});
  core.ops.applyBootstrap(snapshot());
  assert.equal(toasts.length, 0);
  core.state.snapshot.shortcuts.quickSelectSession = "CommandOrControl+K";
  core.ops.applyShortcutFailures({ quickSelectSession: "system conflict", unknownAction: "system conflict" });
  assert.equal(toasts.length, 0);
});

test("browser-mode shortcut labels describe the browser list and preserve CLI quick-mode labels", () => {
  for (const moriCliEnabled of [false, true]) {
    const { core } = loadSettingsCore({ moriCliEnabled });
    core.ops.applyBootstrap(snapshot());
    assert.equal(core.readers.getShortcutActionLabel("quickSelectSession"),
      moriCliEnabled ? "セッションをクイック選択" : "ブラウザのセッションを開く");
    assert.equal(core.helpers.t("settingsWindowTitle"), "Mori Desk 設定");
  }
});

function loadPreload(argv, onSend = () => {}) {
  const surfaces = {};
  const context = {
    process: { argv },
    require: id => {
      assert.equal(id, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { surfaces[name] = value; } },
        ipcRenderer: { on() {}, send: onSend, invoke: () => Promise.resolve({}) },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "preload-settings.js"), "utf8"), context);
  return surfaces.settingsAPI;
}

test("the Settings window passes its product mode through the sandboxed preload", () => {
  for (const moriCliEnabled of [false, true]) {
    let createdOptions;
    class BrowserWindow {
      constructor(options) {
        createdOptions = options;
        this.webContents = { isDestroyed: () => false, once() {}, on() {} };
      }
      isDestroyed() { return false; }
      setMenuBarVisibility() {}
      loadFile() {}
      on() {}
      once() {}
    }
    const runtime = createSettingsWindowRuntime({
      app: { isPackaged: false, isReady: () => true, getAppPath: () => "/app" },
      BrowserWindow,
      nativeTheme: { shouldUseDarkColors: false },
      fs: { existsSync: () => false },
      isWin: true, platform: "win32",
      moriCliEnabled,
      setTimeout: () => 1, clearTimeout() {},
    });
    runtime.open();
    const sends = [];
    const api = loadPreload(createdOptions.webPreferences.additionalArguments,
      (...args) => sends.push(args));
    assert.equal(api.moriCliEnabled, moriCliEnabled);
    assert.equal(createdOptions.webPreferences.nodeIntegration, false);
    assert.equal(createdOptions.webPreferences.contextIsolation, true);
    api.openDashboard();
    assert.deepEqual(sends, [["settings:open-dashboard"]]);
  }
});

test("a missing or malformed product-mode preload flag does not claim CLI mode", () => {
  for (const argv of [[], ["--mori-cli-enabled=true"], ["--mori-cli-enabled=0"]]) {
    assert.equal(loadPreload(argv).moriCliEnabled, false);
  }
});
