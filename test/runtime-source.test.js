"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const sourceRoot = path.resolve(__dirname, "..");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mori-source & paths! "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "object" ? JSON.stringify(value) : value);
  };
  for (const name of ["prepare-runtime.js", "doctor.js"]) write(`scripts/${name}`, fs.readFileSync(path.join(sourceRoot, "scripts", name), "utf8"));
  const lock = { schemaVersion: 1, project: "mori-desk", repository: "https://github.com/rullerzhou-afk/clawd-on-desk.git", commit: "1".repeat(40) };
  const pkg = { name: "mori-desk", version: "0.1.3-preview.1", build: { appId: "com.kaduiro.moridesk", publish: null } };
  write("upstream.lock.json", lock); write("patches/mori.patch", "source patch\n");
  write("package.json", pkg); write(".runtime/package.json", pkg);
  const files = [
    ["extensions/browser-bridge/manifest.json", JSON.stringify({ version: "0.1.7" })],
    ["extensions/browser-bridge/worker.js", "// expected worker\n"],
    ["src/panel.js", "// expected panel\n"],
  ];
  // This fixture encodes the documented input format independently of the
  // implementation helper. The tests change source and built files separately.
  const hash = crypto.createHash("sha256").update(JSON.stringify(lock)).update("source patch\n");
  for (const [relative, data] of files) {
    write(`overlay/${relative}`, data); write(`.runtime/${relative}`, data);
    hash.update(relative).update("\0").update(data);
  }
  const marker = { schemaVersion: 1, project: "mori-desk", projectRoot: fs.realpathSync(root), kind: "runtime", ready: true,
    upstreamCommit: lock.commit, inputFingerprint: hash.digest("hex") };
  write(".runtime/.mori-owned.json", marker);
  const prepare = require(path.join(root, "scripts/prepare-runtime.js"));
  const doctor = require(path.join(root, "scripts/doctor.js"));
  return { root, write, prepare, doctor, marker };
}

test("unchanged pinned inputs and overlay can start; unrelated documentation does not invalidate the build", t => {
  const f = fixture(t);
  assert.equal(f.prepare.requireRuntime(), path.join(f.root, ".runtime"));
  f.write("docs/work-note.md", "A documentation-only change.");
  assert.equal(f.prepare.requireRuntime(), path.join(f.root, ".runtime"));
});

test("pulling changed overlay with the same app/extension version blocks the old runtime without modifying it", t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.root, ".runtime/extensions/browser-bridge/worker.js"));
  f.write("overlay/extensions/browser-bridge/worker.js", "// fixed worker, unchanged version\n");
  assert.throws(() => f.prepare.requireRuntime(), /MORI_RUNTIME_SOURCE_MISMATCH.*setup-windows\.bat/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".runtime/extensions/browser-bridge/worker.js")), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, ".runtime/.mori-owned.json"))), f.marker);
});

test("a changed patch and a missing legacy fingerprint both require a rebuild", t => {
  const f = fixture(t);
  f.write("patches/mori.patch", "new patch, same pin\n");
  assert.throws(() => f.prepare.requireRuntime(), /MORI_RUNTIME_SOURCE_MISMATCH/);
  f.write("patches/mori.patch", "source patch\n");
  const legacy = { ...f.marker }; delete legacy.inputFingerprint;
  f.write(".runtime/.mori-owned.json", legacy);
  assert.throws(() => f.prepare.requireRuntime(), /MORI_RUNTIME_SOURCE_MISMATCH/);
});

test("a valid input stamp cannot hide a changed or missing runtime overlay file", t => {
  const f = fixture(t);
  f.write(".runtime/src/panel.js", "// old or modified runtime\n");
  assert.throws(() => f.prepare.requireRuntime(), /MORI_RUNTIME_SOURCE_MISMATCH/);
  fs.unlinkSync(path.join(f.root, ".runtime/src/panel.js"));
  assert.throws(() => f.prepare.requireRuntime(), /MORI_RUNTIME_SOURCE_MISMATCH/);
});

test("disk doctor separates matching files from unobserved live Chrome, desktop and provider behavior", async t => {
  const f = fixture(t);
  const report = await f.doctor.collectReport();
  assert.equal(report.diskChecksPassed, true);
  assert.equal(report.runtime.sourceMatches, true);
  assert.equal(report.runtime.productIdentityMatches, true);
  assert.equal(report.runtime.extension.status, "matches_source");
  assert.equal(report.browserLoadedExtension, "NOT_CHECKED");
  assert.equal(report.runtime.runningDesktop, "NOT_CHECKED");
  assert.equal(report.runtime.inheritedRuntimeFiles, "NOT_CHECKED");
  assert.equal(report.providerAcceptance, "NOT_CHECKED");
  assert.equal(report.automaticRecovery, "NOT_CHECKED");
  assert.equal(report.selectedExtension, null);
});

test("doctor detects a different selected folder even when both manifest versions are identical", async t => {
  const f = fixture(t);
  f.write("selected/manifest.json", { version: "0.1.7" });
  f.write("selected/worker.js", "// stale code without a version bump\n");
  const report = await f.doctor.collectReport({ extensionDir: path.join(f.root, "selected") });
  assert.equal(report.runtime.sourceMatches, true);
  assert.equal(report.selectedExtension.version, "0.1.7");
  assert.deepEqual(report.selectedExtension.changed, ["worker.js"]);
  assert.equal(report.selectedExtension.status, "mismatch");
  assert.equal(report.diskChecksPassed, false);
  assert.equal(report.browserLoadedExtension, "NOT_CHECKED");
});

test("doctor reports unavailable runtime and missing selected files without auto repair", async t => {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, ".runtime"), { recursive: true });
  f.write("selected/manifest.json", { version: "0.1.6" });
  const report = await f.doctor.collectReport({ extensionDir: path.join(f.root, "selected") });
  assert.equal(report.runtime.source.status, "unavailable");
  assert.equal(report.runtime.extension.status, "unavailable");
  assert.deepEqual(report.selectedExtension.missing, ["worker.js"]);
  assert.equal(report.diskChecksPassed, false);
  assert.equal(fs.existsSync(path.join(f.root, ".runtime")), false);
});

test("doctor does not approve a runtime with an invalid product identity", async t => {
  const f = fixture(t);
  f.write(".runtime/package.json", { name: "different-product", version: "0.1.3-preview.1", build: { appId: "com.example.app", publish: null } });
  const report = await f.doctor.collectReport();
  assert.equal(report.runtime.sourceMatches, true);
  assert.equal(report.runtime.productIdentityMatches, false);
  assert.equal(report.diskChecksPassed, false);
  assert.throws(() => f.prepare.requireRuntime(), /product identity/);
});

test("doctor reports a non-file manifest as unreadable without trying to parse it", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "selected", "manifest.json"), { recursive: true });
  f.write("selected/worker.js", "// expected worker\n");
  const report = await f.doctor.collectReport({ extensionDir: path.join(f.root, "selected") });
  assert.equal(report.selectedExtension.version, null);
  assert.deepEqual(report.selectedExtension.unreadable, ["manifest.json"]);
  assert.equal(report.selectedExtension.status, "mismatch");
  assert.equal(report.diskChecksPassed, false);
});
