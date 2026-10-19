"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createMoriSessionNavigation = require("../src/mori-session-navigation");
const { registerSessionIpc } = require("../src/session-ipc");
const shortcuts = require("../src/shortcut-actions");

test("Mori has its own default shortcut and preserves saved bindings, including unassigned", () => {
  assert.equal(shortcuts.getDefaultShortcuts().togglePet, "CommandOrControl+Shift+Alt+M");
  for (const togglePet of ["CommandOrControl+Shift+Alt+C", "CommandOrControl+K", null]) {
    const saved = { ...shortcuts.getDefaultShortcuts(), togglePet };
    const original = { ...saved };
    const normalized = shortcuts.normalizeShortcuts(saved, undefined, { platform: "win32" });
    assert.equal(normalized.togglePet, togglePet);
    assert.deepEqual(saved, original);
  }
  assert.equal(shortcuts.isShortcutActionSupported("quickSelectSession", "win32"), true);
  assert.equal(shortcuts.isShortcutActionSupported("quickSelectSession", "darwin"), true);
  assert.equal(shortcuts.isShortcutActionSupported("quickSelectSession", "linux"), false);
});

function createNavigationHarness(cliEnabled) {
  const calls = [];
  const navigation = createMoriSessionNavigation({
    cliEnabled,
    openBrowser: () => { calls.push(["browser"]); return "browser-window"; },
    openCliDashboard: options => { calls.push(["cli", options]); return "cli-window"; },
    openCliQuickSelect: () => { calls.push(["quick"]); return "cli-quick-window"; },
  });
  return { navigation, calls };
}

test("browser-mode Settings, HUD, pet and configured shortcut entries open the browser panel", () => {
  const { navigation, calls } = createNavigationHarness(false);
  const handlers = new Map();
  const listeners = new Map();
  const noop = () => {};
  const ipc = registerSessionIpc({
    ipcMain: {
      handle: (channel, callback) => handlers.set(channel, callback),
      on: (channel, callback) => listeners.set(channel, callback),
      removeHandler: channel => handlers.delete(channel),
      removeListener: channel => listeners.delete(channel),
    },
    getSessionSnapshot: () => ({ sessions: [] }),
    getI18n: () => ({}),
    focusSession: noop, hideSession: noop, setSessionAlias: noop,
    showDashboard: navigation.showDashboard,
    setSessionHudPinned: noop, ackSessionCompletion: noop, openSessionFolder: noop,
    setSessionAutomationOverride: noop, clearSessionAutomationGrant: noop,
    getDashboardWebContents: () => null,
    getKimiQuotaStatus: noop, refreshKimiQuota: noop,
    getSessionHistory: noop, resumeSessionFromHistory: noop,
  });
  for (const channel of ["settings:open-dashboard", "session-hud:open-dashboard", "show-dashboard"]) {
    assert.equal(listeners.get(channel)(), "browser-window");
  }
  assert.equal(navigation.showQuickSelect(), "browser-window");
  assert.deepEqual(calls, [["browser"], ["browser"], ["browser"], ["browser"]]);
  ipc.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(handlers.size, 0);
});

test("CLI mode preserves Dashboard source options and numeric quick-mode ownership", () => {
  const { navigation, calls } = createNavigationHarness(true);
  const options = { source: "settings" };
  assert.equal(navigation.showDashboard(options), "cli-window");
  assert.equal(navigation.showQuickSelect(), "cli-quick-window");
  assert.deepEqual(calls, [["cli", options], ["quick"]]);
  assert.strictEqual(calls[0][1], options);
});

test("omitting the product mode defaults session navigation to browser mode", () => {
  const { navigation, calls } = createNavigationHarness(undefined);
  assert.equal(navigation.showDashboard(), "browser-window");
  assert.deepEqual(calls, [["browser"]]);
});
