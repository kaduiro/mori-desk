"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const prepare = require("./prepare-runtime");
const { failure } = require("../overlay/src/mori-startup-contract");
const LOCK = path.join(prepare.ROOT, ".mori-setup-lock");

function checkLaunchLock(owner) {
  let marker;
  try { fs.lstatSync(LOCK); }
  catch (error) {
    if (error.code === "ENOENT" && !owner) return;
    throw failure("setup_busy");
  }
  try { marker = prepare.requireOwner(LOCK, ["startup-lock"]); }
  catch { throw failure("setup_busy"); }
  if (!owner || marker.token !== owner.token || marker.pid !== owner.pid) throw failure("setup_busy");
}

function acquireStartupLock() {
  const dir = prepare.assertSafePath(LOCK);
  try { fs.mkdirSync(dir); } catch { throw failure("setup_busy"); }
  const owner = { token: crypto.randomUUID(), pid: process.pid };
  try {
    fs.writeFileSync(path.join(dir, ".mori-owned.json"), JSON.stringify({ schemaVersion: 1,
      project: "mori-desk", projectRoot: prepare.ROOT, kind: "startup-lock", ...owner }) + "\n", { mode: 0o600 });
  } catch (error) {
    // An incomplete lock is preserved. It is never assumed to be ours later.
    throw failure("setup_busy");
  }
  return { owner, release() {
    checkLaunchLock(owner);
    prepare.removeOwned(dir, ["startup-lock"]);
  } };
}

function readStartupOwner(env, parentPid) {
  if (env.MORI_STARTUP_LOCK_TOKEN === undefined && env.MORI_STARTUP_PARENT_PID === undefined) return null;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(env.MORI_STARTUP_LOCK_TOKEN || "")
      || String(parentPid) !== env.MORI_STARTUP_PARENT_PID) throw failure("setup_busy");
  return { token: env.MORI_STARTUP_LOCK_TOKEN, pid: parentPid };
}

function verifySourceStartup({ appPath = prepare.RUNTIME, execPath, owner = null } = {}) {
  checkLaunchLock(owner);
  let runtime;
  try { runtime = prepare.requireRuntime(); }
  catch (error) {
    throw failure(String(error.message).includes("MORI_RUNTIME_SOURCE_MISMATCH") ? "source_mismatch" : "runtime_unavailable");
  }
  if (path.resolve(appPath) !== runtime) throw failure("runtime_unavailable");
  const bootstrap = path.join(prepare.ROOT, "bootstrap");
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(bootstrap, "package.json"), "utf8"));
    if (manifest.name !== "mori-desk-bootstrap" || manifest.main !== "main.js"
        || !fs.statSync(path.join(bootstrap, "main.js")).isFile()) throw new Error("entry");
  } catch { throw failure("runtime_unavailable"); }
  const { verifyElectronInstall } = require(path.join(runtime, "scripts/verify-electron-install"));
  const env = { ...process.env }; delete env.ELECTRON_OVERRIDE_DIST_PATH;
  const electron = verifyElectronInstall({ context: "launch", rootDir: runtime, env });
  if (!electron.ok || !electron.executablePath) throw failure("electron_invalid");
  if (execPath && fs.realpathSync(execPath) !== fs.realpathSync(electron.executablePath)) throw failure("electron_invalid");
  const buildInfo = JSON.parse(fs.readFileSync(path.join(runtime, "src/mori-build-info.json"), "utf8"));
  checkLaunchLock(owner);
  return Object.freeze({ runtime, bootstrap,
    executable: electron.executablePath, buildInfo: Object.freeze(buildInfo) });
}
module.exports = { verifySourceStartup, acquireStartupLock, checkLaunchLock, readStartupOwner };
