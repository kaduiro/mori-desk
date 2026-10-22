"use strict";

// A source launcher only. The child owns all Mori user data, windows and locks.
const { app, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const guard = require("../scripts/startup-guard");
const { parseStartupArgs, reasonOf, waitForStartup, failure } = require("../overlay/src/mori-startup-contract");

async function main() {
  let lock, child, result, startup;
  try {
    startup = parseStartupArgs(process.argv.slice(2), { strict: true });
    // A concurrent launcher may finish normally; setup/unknown/stale locks are
    // never stolen. Retrying only acquisition does not spawn a second child.
    const deadline = Date.now() + 15000;
    while (!lock) {
      try { lock = guard.acquireStartupLock(); }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        // Only wait for another live startup, never a setup or foreign lock.
        const prepare = require("../scripts/prepare-runtime");
        let marker;
        try { marker = prepare.requireOwner(path.join(prepare.ROOT, ".mori-setup-lock"), ["startup-lock"]); }
        catch { throw failure("setup_busy"); }
        try { process.kill(marker.pid, 0); } catch { throw failure("setup_busy"); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const verified = guard.verifySourceStartup({ execPath: process.execPath, owner: lock.owner });
    const env = { ...process.env, MORI_STARTUP_LOCK_TOKEN: lock.owner.token, MORI_STARTUP_PARENT_PID: String(process.pid) };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_OVERRIDE_DIST_PATH;
    let childArgs = [verified.runtime, `--mori-startup=${startup.reason}`, ...(startup.cli ? ["--enable-cli"] : [])];
    // Preserve the existing Linux backend choice without an extra self-spawn
    // that would lose this parent's single IPC handoff and lock ownership.
    if (process.platform === "linux") {
      const plan = require(path.join(verified.runtime, "src/linux-ozone")).planXWaylandRelaunch({
        platform: process.platform, env, argv: [verified.executable, ...childArgs],
      });
      if (plan) childArgs = plan.args;
    }
    child = spawn(verified.executable, childArgs, {
      shell: false, detached: true, cwd: verified.runtime, windowsHide: true,
      env, stdio: ["ignore", startup.isLogin ? "ignore" : "inherit", startup.isLogin ? "ignore" : "inherit", "ipc"],
    });
    result = await waitForStartup(child, verified.buildInfo.buildId);
    if (result.status === "redirected_unknown" && !startup.isLogin)
      console.info("Mori Desk: 既存の Mori を使用しています。稼働版は未確認です。");
  } catch (error) { result = { status: "blocked", reason: reasonOf(error) }; }
  finally {
    if (child) {
      try { if (child.connected) child.disconnect(); } catch {}
      child.unref();
    }
    if (lock) {
      try { lock.release(); }
      catch { console.error("Mori Desk: 起動ロックを解放できませんでした。通常の修復手順を確認してください。"); }
    }
  }
  if (result.status === "blocked" || result.status === "startup_unconfirmed") {
    dialog.showErrorBox("Mori Desk", `本体の起動を確認できませんでした（${result.reason}）。\n` +
      "起動中の Mori とセットアップの状態を確認し、通常の setup-windows.bat と起動手順で修復してください。保存済みデータは初期化していません。");
    app.exit(1);
  } else app.exit(0);
}
app.whenReady().then(main).catch(() => app.exit(1));
