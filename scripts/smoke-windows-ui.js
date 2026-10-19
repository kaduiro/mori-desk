"use strict";

// This integration check owns an isolated Electron process and data directory.
// It tests the assembled application, not the user's Chrome or desktop session.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { requireRuntime } = require("./prepare-runtime");

async function main() {
  if (process.platform !== "win32") throw new Error("This native UI check runs on Windows.");
  const runtime = requireRuntime();
  const electron = require(path.join(runtime, "node_modules", "electron"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "mori-owned-ui-smoke-"));
  const env = { ...process.env, MORI_DESK_TEST_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(runtime, "test", "mori-native-window-smoke.js")],
        { cwd: runtime, env, stdio: "inherit", shell: false, windowsHide: false });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve()
        : reject(new Error(`Owned Electron UI check failed (${code ?? signal}).`)));
    });
  } finally {
    // mkdtemp above is the sole source of this path. Never touch user profiles.
    try { fs.rmSync(data, { recursive: true }); }
    catch { console.warn("The owned temporary UI profile could not be fully removed."); }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
