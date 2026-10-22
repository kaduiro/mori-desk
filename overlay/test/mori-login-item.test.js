"use strict";

// These are policy tests, not evidence that Windows accepted a registration.
// The model captures Electron 41's full-command openAtLogin comparison and
// switch-filtering launchItems; it never writes to the host registry.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLoginItemController, PRODUCT_ID } = require("../src/mori-login-item");
const { createRegistrationNameProbe } = require("../src/mori-login-registry");
const exe = "C:\\A space & 日本語\\electron.exe";
const runtime = "C:\\A space & 日本語\\.runtime";
const bootstrap = "C:\\A space & 日本語\\bootstrap";
const currentArgs = [bootstrap, "--mori-startup=login"];

function fixture({ entry = null, machine = false, readbackFails = false, probeFails = false } = {}) {
  let installed = entry;
  const writes = [], queries = [];
  const app = { isPackaged: false,
    getLoginItemSettings(query) {
      queries.push(query);
      assert.equal(query.path, `"${exe}"`, "only query.exe needs outer quotes for Electron 41 lookup");
      const equal = installed && installed.path === exe && JSON.stringify(installed.args) === JSON.stringify(query.args);
      return { openAtLogin: !!equal, executableWillLaunchAtLogin: !!installed,
        launchItems: installed?.path === exe ? [{ name: PRODUCT_ID, path: exe, scope: "user", enabled: installed.enabled,
          args: installed.args.filter(arg => !arg.startsWith("--")) }] : [] };
    },
    setLoginItemSettings(value) {
      writes.push(value);
      if (!readbackFails) installed = value.openAtLogin ? { path: value.path, args: value.args, enabled: value.enabled } : null;
    },
  };
  const controller = createLoginItemController({ app, platform: "win32", execPath: exe, appPath: runtime, bootstrapPath: bootstrap,
    samePath: (left, right) => left === right,
    probeName: () => ({ user: probeFails ? null : !!installed, machine }),
  });
  return { controller, writes, queries, app };
}

test("default-off reads do not register; explicit enable sends unquoted path argument and verifies full command", () => {
  const f = fixture();
  assert.deepEqual(f.controller.getStatus(), { state: "disabled", enabled: false, reason: "not_registered" });
  assert.equal(f.writes.length, 0);
  assert.equal(f.controller.setEnabled(true).state, "enabled");
  assert.deepEqual(f.writes, [{ openAtLogin: true, path: exe, args: currentArgs, name: PRODUCT_ID, enabled: true }]);
  assert.equal(f.controller.setEnabled(false).state, "disabled");
});

test("OS-disabled current entry remains disabled until an explicit user action", () => {
  const f = fixture({ entry: { path: exe, args: currentArgs, enabled: false } });
  assert.deepEqual(f.controller.getStatus(), { state: "os_disabled", enabled: false, reason: "os_disabled" });
  f.controller.getStatus();
  assert.equal(f.writes.length, 0);
  assert.equal(f.controller.setEnabled(true).state, "enabled");
});

test("legacy exact entry is read-only at startup and migrates only through explicit enable", () => {
  const f = fixture({ entry: { path: exe, args: [runtime], enabled: true } });
  assert.deepEqual(f.controller.getStatus(), { state: "legacy", enabled: true, reason: "migration_required" });
  assert.equal(f.writes.length, 0);
  assert.equal(f.controller.setEnabled(true).state, "enabled");
  assert.deepEqual(f.writes[0].args, currentArgs);
});

test("same executable with wrong or extra switch is foreign even though launchItems drops the switch", () => {
  for (const args of [[bootstrap, "--mori-startup=manual"], [...currentArgs, "--enable-cli"], [runtime, "--foreign-switch"]]) {
    const f = fixture({ entry: { path: exe, args, enabled: true } });
    assert.equal(f.controller.getStatus().reason, "foreign_registration");
    assert.throws(() => f.controller.setEnabled(true), /foreign_registration/);
    assert.throws(() => f.controller.setEnabled(false), /foreign_registration/);
    assert.equal(f.writes.length, 0);
  }
});

test("a foreign executable hidden by Electron's enumeration cannot be overwritten or deleted", () => {
  const f = fixture({ entry: { path: "C:\\Other\\electron.exe", args: currentArgs, enabled: true } });
  assert.equal(f.controller.getStatus().reason, "foreign_registration");
  assert.throws(() => f.controller.setEnabled(true), /foreign_registration/);
  assert.throws(() => f.controller.setEnabled(false), /foreign_registration/);
  assert.equal(f.writes.length, 0);
});

test("unreadable native presence and machine-scope conflicts never become absent", () => {
  for (const [options, reason] of [[{ probeFails: true }, "registration_probe_failed"], [{ machine: true }, "registration_ambiguous"]]) {
    const f = fixture(options);
    assert.equal(f.controller.getStatus().enabled, null);
    assert.equal(f.controller.getStatus().reason, reason);
    assert.throws(() => f.controller.setEnabled(true));
    assert.equal(f.writes.length, 0);
  }
});

test("a setter return without matching read-back is not success", () => {
  const f = fixture({ readbackFails: true });
  assert.throws(() => f.controller.setEnabled(true), /login_readback_failed/);
  assert.equal(f.controller.getStatus().state, "disabled");
  assert.equal(f.writes.length, 1);
});

test("duplicate or wrong-scope named launchItems remain ambiguous", () => {
  for (const list of [
    [{ name: PRODUCT_ID, scope: "machine", path: exe, enabled: true }],
    [{ name: PRODUCT_ID, scope: "user", path: exe, enabled: true }, { name: PRODUCT_ID, scope: "user", path: exe, enabled: true }],
  ]) {
    let writes = 0;
    const controller = createLoginItemController({ platform: "win32", execPath: exe, appPath: runtime, bootstrapPath: bootstrap,
      app: { isPackaged: false, getLoginItemSettings: () => ({ openAtLogin: true, launchItems: list }), setLoginItemSettings: () => writes++ },
      samePath: (left, right) => left === right, probeName: () => ({ user: true, machine: false }) });
    assert.equal(controller.getStatus().reason, "registration_ambiguous");
    assert.throws(() => controller.setEnabled(false));
    assert.equal(writes, 0);
  }
});

test("native probe uses only the fixed name and treats only ERROR_FILE_NOT_FOUND as absence", () => {
  const calls = []; let result = 0; let loaded = 0;
  const probe = createRegistrationNameProbe({ platform: "win32", loadKoffi: () => ({ load(name) {
    loaded++; assert.equal(name, "advapi32.dll");
    return { func(signature) { assert.match(signature, /RegGetValueW/); return (...args) => { calls.push(args); return result; }; } };
  } }) });
  assert.deepEqual(probe(), { user: true, machine: true });
  result = 2; assert.deepEqual(probe(), { user: false, machine: false });
  for (const code of [5, 87, 234]) { result = code; assert.deepEqual(probe(), { user: null, machine: null }); }
  assert.equal(loaded, 1);
  assert.deepEqual(calls[0], [-2147483647, "Software\\Microsoft\\Windows\\CurrentVersion\\Run", PRODUCT_ID, 0x1000ffff, null, null, null]);
  assert.equal(calls[1][0], -2147483646);
});
