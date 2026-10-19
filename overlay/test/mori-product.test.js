"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const product = require("../src/mori-product");
const prefs = require("../src/prefs");

test("new Mori data is independent from the original product", () => {
  const calls = [];
  const app = { isPackaged: true, setName: n => calls.push(["name", n]), getPath: () => "/appdata", setPath: (k,v) => calls.push([k,v]) };
  product.configureApp(app);
  assert.deepEqual(calls, [["name", "Mori Desk"], ["userData", path.join("/appdata", "MoriDesk")]]);
});

test("browser-only runtime creation and cleanup stay in the Mori directory", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-runtime-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(product.cliEnabled, false);
  const options = product.privateRuntimeOptions(dir);
  assert.equal(options.writeRuntimeConfig(23335), true);
  assert.equal(options.readRuntimePort(), 23335);
  assert.equal(options.runtimeConfigPath, path.join(dir, "browser-runtime.json"));
  assert.equal(options.clearRuntimeConfig(), true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("fresh installs require an explicit CLI integration and keep HUD visible", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-prefs-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const value = prefs.load(path.join(dir, "prefs.json")).snapshot;
  assert.equal(value.theme, "mori");
  assert.equal(value.sessionHudPinned, true);
  assert.equal(value.soundMuted, true);
  for (const id of ["claude-code", "codex"]) {
    assert.equal(value.agents[id].enabled, false);
    assert.equal(value.agents[id].integrationInstalled, false);
  }
  assert.throws(() => product.requireCliMode(), /CLI/);
});

test("a crashed CLI runtime owner does not permanently block the next launch", () => {
  const probed = [];
  assert.doesNotThrow(() => product.assertCliRuntimeAvailable({
    cliEnabled: true,
    ownPid: 123,
    readRuntimeIdentity: () => ({ ok: true, ownerPid: 456, port: 23333 }),
    probeProcess: pid => { probed.push(pid); const error = new Error("gone"); error.code = "ESRCH"; throw error; },
  }));
  assert.deepEqual(probed, [456]);
});

test("a live or uncertain CLI runtime owner remains protected", () => {
  for (const code of [null, "EPERM", "EACCES", "UNKNOWN"]) {
    assert.throws(() => product.assertCliRuntimeAvailable({
      cliEnabled: true,
      ownPid: 123,
      readRuntimeIdentity: () => ({ ok: true, ownerPid: 456, port: 23333 }),
      probeProcess: () => {
        if (code) { const error = new Error(code); error.code = code; throw error; }
        return true;
      },
    }), { code: "MORI_CLI_RUNTIME_BUSY" });
  }
});

test("browser-only startup does not inspect or mutate the shared CLI runtime", () => {
  let inspected = false;
  product.assertCliRuntimeAvailable({
    cliEnabled: false,
    readRuntimeIdentity: () => { inspected = true; throw new Error("must not read shared runtime"); },
    probeProcess: () => { throw new Error("must not inspect CLI process"); },
  });
  assert.equal(inspected, false);
});

test("the current process can recheck its own runtime without a foreign-owner conflict", () => {
  assert.doesNotThrow(() => product.assertCliRuntimeAvailable({
    cliEnabled: true,
    ownPid: 123,
    readRuntimeIdentity: () => ({ ok: true, ownerPid: 123, port: 23333 }),
    probeProcess: () => { throw new Error("own runtime should not need a probe"); },
  }));
});

test("CLI runtime publishing rechecks ownership before every startup or Doctor write", () => {
  let identity = { ok: false, ownerPid: null };
  const writes = [];
  const options = product.privateRuntimeOptions("/unused/mori", {
    cliEnabled: true,
    ownPid: 123,
    readRuntimeIdentity: () => identity,
    probeProcess: () => true,
    writeRuntimeConfig: (port, extra) => { writes.push({ port, extra }); return true; },
  });
  const extra = { windowsProcessChain: { version: 1 } };
  assert.equal(options.writeRuntimeConfig(23333, extra), true);
  identity = { ok: true, ownerPid: 456, port: 23334 };
  assert.throws(() => options.writeRuntimeConfig(23333, extra), { code: "MORI_CLI_RUNTIME_BUSY" });
  assert.deepEqual(writes, [{ port: 23333, extra }]);
  identity = { ok: true, ownerPid: 123, port: 23333 };
  assert.equal(options.writeRuntimeConfig(23333, extra), true);
});

test("manual CLI integration mutations stop when a live foreign runtime takes ownership", () => {
  assert.throws(() => product.requireCliMode({
    cliEnabled: true,
    ownPid: 123,
    readRuntimeIdentity: () => ({ ok: true, ownerPid: 456, port: 23334 }),
    probeProcess: () => true,
  }), { code: "MORI_CLI_RUNTIME_BUSY" });
});
