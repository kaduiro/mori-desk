"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contract = require("../src/mori-startup-contract");
const { initializeStartup, bridgeBuildInfo } = require("../src/mori-startup");
const buildId = "7".repeat(64);

test("startup reasons are bounded and login cannot enable CLI", () => {
  assert.deepEqual(contract.parseStartupArgs([]), { reason: "manual", cli: false, isLogin: false });
  assert.equal(contract.parseStartupArgs(["--mori-startup=login"]).isLogin, true);
  assert.equal(contract.parseStartupArgs(["--enable-cli"]).cli, true);
  for (const argv of [["--mori-startup=other"], ["--mori-startup=manual", "--mori-startup=login"],
    ["--mori-startup=login", "--enable-cli"], ["--enable-cli", "--enable-cli"], [7]]) {
    assert.throws(() => contract.parseStartupArgs(argv), { code: "invalid_arguments" });
  }
  assert.throws(() => contract.parseStartupArgs(["--open-settings-window"], { strict: true }), { code: "invalid_arguments" });
  assert.equal(contract.parseStartupArgs(["--open-settings-window"]).reason, "manual");
});

test("handoff rejects a wrong build, extra data, oversized and malformed messages", async () => {
  const child = new EventEmitter(); let kills = 0; child.kill = () => kills++;
  const pending = contract.waitForStartup(child, buildId, { timeoutMs: 200 });
  child.emit("message", contract.makeResult("started", "8".repeat(64)));
  child.emit("message", { ...contract.makeResult("started", buildId), url: "https://private.invalid" });
  child.emit("message", contract.makeResult("blocked", buildId, "x".repeat(1100)));
  const cyclic = contract.makeResult("started", buildId); cyclic.reason = cyclic;
  child.emit("message", cyclic);
  child.emit("message", { ...contract.makeResult("started", buildId), reason: 1n });
  child.emit("message", contract.makeResult("redirected_unknown", buildId));
  assert.deepEqual(await pending, contract.makeResult("redirected_unknown", buildId));
  assert.equal(kills, 0);
  assert.equal(child.listenerCount("message"), 0);
});

test("a clean exit or a silent timeout is unconfirmed and never kills or restarts a child", async () => {
  for (const exit of [true, false]) {
    const child = new EventEmitter(); let kills = 0; child.kill = () => kills++;
    const pending = contract.waitForStartup(child, buildId, { timeoutMs: 15 });
    if (exit) child.emit("exit", 0, null);
    assert.equal((await pending).status, "startup_unconfirmed");
    assert.equal(kills, 0);
    child.emit("error", new Error("late error"));
  }
});

test("spawn errors and source rejection retain separate bounded reasons", async () => {
  const child = new EventEmitter();
  const pending = contract.waitForStartup(child, buildId);
  child.emit("error", new Error("private executable path"));
  assert.deepEqual(await pending, contract.makeResult("blocked", buildId, "spawn_failed"));
  assert.equal(contract.reasonOf(new Error("private details")), "runtime_unavailable");
  assert.equal(contract.reasonOf(contract.failure("source_mismatch")), "source_mismatch");
});

test("reporter sends one exact handoff and awaits the send callback", async () => {
  const messages = []; let callback;
  const reporter = contract.createReporter({ connected: true, send(value, done) { messages.push(value); callback = done; } }, { buildId });
  let completed = false;
  const first = reporter.report("started").then(value => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(await reporter.report("redirected_unknown"), false);
  callback(null);
  assert.equal(await first, true);
  assert.deepEqual(messages, [contract.makeResult("started", buildId)]);
  const disconnected = contract.createReporter({ connected: false, send() { throw Error("must not send"); } }, { buildId });
  assert.equal(await disconnected.report("started"), false);
});

test("real Node child IPC preserves handoff classification without treating process exit as readiness", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-ipc & entry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "child.js");
  fs.writeFileSync(file, `if (process.argv[2] === 'send') process.send(${JSON.stringify(contract.makeResult("started", buildId))}, () => process.exit(0));\n`);
  for (const [mode, expected] of [["send", "started"], ["exit", "startup_unconfirmed"]]) {
    const child = fork(file, [mode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    assert.equal((await contract.waitForStartup(child, buildId)).status, expected);
  }
});

test("packaged entry validates embedded identity/build without source checkout or external Node", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-packaged-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"));
  // This is the shipped shape: electron-builder strips the build field.
  const pkg = { name: "mori-desk", version: "0.1.3-preview.1" };
  const info = { schema: 1, product: "mori-desk", version: pkg.version, buildId, observerContract: 1 };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, "src/mori-build-info.json"), JSON.stringify(info));
  const app = { isPackaged: true, getAppPath: () => dir };
  const processObject = { argv: ["mori.exe", "--mori-startup=login"], env: {}, execPath: "unused", ppid: 1 };
  const startup = initializeStartup({ app, processObject });
  assert.equal(startup.isLogin, true);
  startup.recheck();
  assert.deepEqual(bridgeBuildInfo(startup), { desktopVersion: pkg.version, buildId, observerContract: 1 });
  fs.writeFileSync(path.join(dir, "src/mori-build-info.json"), JSON.stringify({ ...info, buildId: [buildId] }));
  assert.throws(() => initializeStartup({ app, processObject }), { code: "build_invalid" });
  fs.writeFileSync(path.join(dir, "src/mori-build-info.json"), JSON.stringify({ ...info, version: "older" }));
  assert.throws(() => initializeStartup({ app, processObject }), { code: "build_invalid" });
});
