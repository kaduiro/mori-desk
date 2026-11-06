"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, requireRuntime, run } = require("./prepare-runtime");
const { checkNodeVersion, runNpm } = require("./setup");

const BUILDS = Object.freeze({
  "build:win:x64": "win32",
  "build:win:arm64": "win32",
  "build:win:all": "win32",
  "build:mac:x64": "darwin",
  "build:mac:arm64": "darwin",
});

function buildScriptFor(command, platform = process.platform) {
  if (!Object.hasOwn(BUILDS, command)) throw new Error(`Unknown Mori command: ${command}`);
  if (BUILDS[command] !== platform)
    throw new Error(`${command} must run on ${BUILDS[command] === "darwin" ? "macOS" : "Windows"}.`);
  return command;
}

function testFiles(runtime) {
  const dir = path.join(runtime, "test");
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:browser|mori)-.*\.test\.js$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name)).sort();
  if (!files.length) throw new Error("No browser-*.test.js or mori-*.test.js files exist in the verified runtime.");
  return files;
}

async function main(args = process.argv.slice(2)) {
  checkNodeVersion();
  const command = args[0] || "start";
  if (!["start", "test", "verify:electron"].includes(command) && !Object.hasOwn(BUILDS, command))
    throw new Error(`Unknown Mori command: ${command}`);
  const runtime = requireRuntime();
  if (command === "start") {
    const launchArgs = args.slice(1);
    if (launchArgs.some((arg) => arg !== "--enable-cli")) throw new Error("The source preview launcher accepts only --enable-cli.");
    if (launchArgs.includes("--enable-cli")) console.log("CLI mode: close the original Clawd on Desk first. This preview does not automatically migrate its settings.");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_OVERRIDE_DIST_PATH;
    delete env.MORI_STARTUP_LOCK_TOKEN;
    delete env.MORI_STARTUP_PARENT_PID;
    const { verifyElectronInstall, formatElectronInstallFailure } = require(path.join(runtime, "scripts/verify-electron-install"));
    const electron = verifyElectronInstall({ context: "launch", rootDir: runtime, env });
    if (!electron.ok) throw new Error(formatElectronInstallFailure(electron));
    await run(electron.executablePath, [path.join(ROOT, "bootstrap"), "--mori-startup=manual", ...launchArgs],
      { cwd: ROOT, capture: false, env });
  } else if (command === "test") {
    const files = [...testFiles(runtime), ...["runtime-source.test.js", "startup-guard.test.js", "prepare-publication.test.js", "windows-process.test.js", "build-entrypoint.test.js"].map(name => path.join(ROOT, "test", name))];
    console.log(`Running ${files.length} browser/Mori and source verification test files.`);
    const isolation = process.platform === "win32" ? ["--test-isolation=none"] : [];
    await run(process.execPath, ["--test", ...isolation, ...files], { cwd: runtime, capture: false });
  } else if (command === "verify:electron") {
    await run(process.execPath, ["scripts/verify-electron-install.js", "--context", "verify"], { cwd: runtime, capture: false });
  } else {
    const script = buildScriptFor(command);
    await runNpm(["run", script], runtime);
    console.log(`Mori Desk ${script} output: ${path.join(runtime, "dist")}`);
  }
}

module.exports = { testFiles, buildScriptFor, main };
if (require.main === module) main().catch((error) => { console.error(`Mori Desk: ${error.message}`); process.exitCode = 1; });
