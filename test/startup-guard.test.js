"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const sourceRoot = path.resolve(__dirname, "..");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mori-start guard & 日本語-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "object" ? JSON.stringify(value) : value);
  };
  for (const file of ["scripts/prepare-runtime.js", "scripts/startup-guard.js", "overlay/src/mori-startup-contract.js"])
    write(file, fs.readFileSync(path.join(sourceRoot, file), "utf8"));
  const pin = { schemaVersion: 1, project: "mori-desk", repository: "https://github.com/rullerzhou-afk/clawd-on-desk.git", commit: "2".repeat(40) };
  const pkg = { name: "mori-desk", version: "0.1.3-preview.1", build: { appId: "com.kaduiro.moridesk", publish: null } };
  write("upstream.lock.json", pin); write("patches/mori.patch", "patch bytes\n");
  write("package.json", pkg); write(".runtime/package.json", pkg);
  write("bootstrap/package.json", { name: "mori-desk-bootstrap", main: "main.js" });
  write("bootstrap/main.js", "// fixture entry\n");
  const overlay = [
    ["extensions/browser-bridge/manifest.json", '{"version":"0.1.8"}'],
    ["src/mori-startup-contract.js", fs.readFileSync(path.join(sourceRoot, "overlay/src/mori-startup-contract.js"), "utf8")],
  ];
  const hash = crypto.createHash("sha256").update(JSON.stringify(pin)).update("patch bytes\n");
  for (const [name, contents] of overlay) {
    write(`overlay/${name}`, contents); write(`.runtime/${name}`, contents);
    hash.update(name).update("\0").update(contents);
  }
  const buildId = hash.digest("hex");
  write(".runtime/.mori-owned.json", { schemaVersion: 1, project: "mori-desk", projectRoot: root, kind: "runtime", ready: true,
    upstreamCommit: pin.commit, inputFingerprint: buildId });
  write(".runtime/src/mori-build-info.json", JSON.stringify({ schema: 1, product: "mori-desk", version: pkg.version, buildId, observerContract: 1 }, null, 2) + "\n");
  write(".runtime/extensions/browser-bridge/build-info.js", '"use strict";\nglobalThis.MoriBrowserBuildInfo = Object.freeze('
    + JSON.stringify({ extensionVersion: "0.1.8", buildId, observerContract: 1 }) + ");\n");
  write(".runtime/electron-bin", "fixture executable");
  // The actual installer verifier has its own suite. This isolates whether
  // the startup guard obeys its result and exact executable, without launching
  // Electron or pretending this fixture validates a Windows installation.
  write(".runtime/scripts/verify-electron-install.js", `exports.verifyElectronInstall = ({env,rootDir}) => {
    if (env.ELECTRON_OVERRIDE_DIST_PATH) throw Error('override leaked');
    return {ok:true, executablePath:require('node:path').join(rootDir,'electron-bin')};
  };\n`);
  return { root, write, buildId, guard: require(path.join(root, "scripts/startup-guard.js")) };
}

test("guard verifies current source with spaces and non-ASCII paths and does not use a different executable", t => {
  const f = fixture(t);
  const current = f.guard.verifySourceStartup({ execPath: path.join(f.root, ".runtime/electron-bin") });
  assert.equal(current.buildInfo.buildId, f.buildId);
  assert.equal(current.runtime, path.join(f.root, ".runtime"));
  assert.equal(current.bootstrap, path.join(f.root, "bootstrap"));
  f.write("other-electron", "other");
  assert.throws(() => f.guard.verifySourceStartup({ execPath: path.join(f.root, "other-electron") }), { code: "electron_invalid" });
  assert.throws(() => f.guard.verifySourceStartup({ appPath: path.join(f.root, "bootstrap") }), { code: "runtime_unavailable" });
});

test("startup lock excludes setup/other launches and requires live matching handoff ownership", t => {
  const f = fixture(t);
  const lock = f.guard.acquireStartupLock();
  assert.throws(() => f.guard.acquireStartupLock(), { code: "setup_busy" });
  assert.throws(() => f.guard.verifySourceStartup(), { code: "setup_busy" });
  const env = { MORI_STARTUP_LOCK_TOKEN: lock.owner.token, MORI_STARTUP_PARENT_PID: String(lock.owner.pid) };
  assert.deepEqual(f.guard.readStartupOwner(env, lock.owner.pid), lock.owner);
  assert.throws(() => f.guard.readStartupOwner(env, lock.owner.pid + 1), { code: "setup_busy" });
  assert.equal(f.guard.verifySourceStartup({ owner: lock.owner }).buildInfo.buildId, f.buildId);
  lock.release();
  // A child that finishes only after its parent timed out must not report a
  // verified startup after the launch/setup exclusion has already ended.
  assert.throws(() => f.guard.verifySourceStartup({ owner: lock.owner }), { code: "setup_busy" });
  assert.equal(f.guard.verifySourceStartup().buildInfo.buildId, f.buildId);
});

test("setup and unowned locks are preserved without stealing or cleanup", t => {
  const f = fixture(t);
  f.write(".mori-setup-lock/.mori-owned.json", { schemaVersion: 1, project: "mori-desk", projectRoot: f.root, kind: "setup-lock" });
  const before = fs.readFileSync(path.join(f.root, ".mori-setup-lock/.mori-owned.json"));
  assert.throws(() => f.guard.verifySourceStartup(), { code: "setup_busy" });
  assert.throws(() => f.guard.acquireStartupLock(), { code: "setup_busy" });
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".mori-setup-lock/.mori-owned.json")), before);
  f.write(".mori-setup-lock/.mori-owned.json", "unreadable marker");
  assert.throws(() => f.guard.verifySourceStartup(), { code: "setup_busy" });
  assert.equal(fs.existsSync(path.join(f.root, ".mori-setup-lock")), true);
});

test("a missing startup entry or generated metadata blocks instead of starting the old combination", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "bootstrap/main.js"));
  assert.throws(() => f.guard.verifySourceStartup(), { code: "runtime_unavailable" });
  f.write("bootstrap/main.js", "restored entry");
  fs.unlinkSync(path.join(f.root, ".runtime/extensions/browser-bridge/build-info.js"));
  assert.throws(() => f.guard.verifySourceStartup(), { code: "source_mismatch" });
});

test("changing source after the first verification invalidates the final handoff recheck", t => {
  const f = fixture(t);
  const lock = f.guard.acquireStartupLock();
  assert.equal(f.guard.verifySourceStartup({ owner: lock.owner }).buildInfo.buildId, f.buildId);
  f.write("patches/mori.patch", "new revision\n");
  assert.throws(() => f.guard.verifySourceStartup({ owner: lock.owner }), { code: "source_mismatch" });
  lock.release();
});
