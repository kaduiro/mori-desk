"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT, run, prepareRuntime, setStageReady, promoteRuntime,
  removeOwned, acquireSetupLock, requireOwner, RUNTIME,
  inspectRuntimeSource, launchReadinessFromSource,
} = require("./prepare-runtime");

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 18)
    throw new Error(`Use Node.js 24.x LTS, version 24.18.0 or newer in the 24.x line. Current: ${process.versions.node}. See .nvmrc.`);
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const entry of String(process.env.PATH || process.env.Path || "").split(path.delimiter)) {
    if (!entry) continue;
    for (const name of ["npm", "npm.cmd"]) {
      const candidate = path.join(entry.replace(/^"|"$/g, ""), name);
      try {
        const real = fs.realpathSync(candidate);
        if (real.endsWith(`${path.sep}npm-cli.js`)) candidates.push(real);
      } catch {}
    }
    candidates.push(path.join(entry.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npm-cli.js"));
  }
  for (const file of candidates) {
    if (typeof file !== "string" || path.basename(file) !== "npm-cli.js") continue;
    try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
  throw new Error("npm's JavaScript CLI was not found. Reinstall Node.js with the npm option selected, then reopen the terminal.");
}

function runNpm(args, cwd) {
  // Invoke npm's JS entry with Node. This avoids cmd.exe / npm.cmd shell quoting
  // and works when the checkout path contains spaces or shell metacharacters.
  return run(process.execPath, [findNpmCli(), "--prefix", cwd, ...args], { cwd, capture: false });
}

function reuseLockedDependencies(stage) {
  const previous = requireOwner(RUNTIME, ["runtime"]);
  requireOwner(stage, ["runtime-stage"]);
  if (previous.ready !== true) throw new Error("The previous runtime is not verified; run the full setup.");
  for (const name of ["package.json", "package-lock.json"]) {
    if (!fs.readFileSync(path.join(RUNTIME, name)).equals(fs.readFileSync(path.join(stage, name))))
      throw new Error(`Cannot reuse dependencies: ${name} changed. Run the full setup.`);
  }
  const source = path.join(RUNTIME, "node_modules");
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The existing dependencies are not an owned runtime directory.");
  fs.cpSync(source, path.join(stage, "node_modules"), { recursive: true, errorOnExist: true, force: false });
}

async function setup({ reuseDependencies = false } = {}) {
  checkNodeVersion();
  findNpmCli();
  await run("git", ["--version"]);
  const releaseLock = acquireSetupLock();
  let stage = null;
  try {
    console.log(`Preparing Mori Desk in ${ROOT}`);
    stage = await prepareRuntime();
    if (reuseDependencies) {
      console.log("Reusing verified runtime dependencies with identical package and lock files...");
      reuseLockedDependencies(stage);
    } else {
      console.log("Installing the locked application dependencies into staging...");
      // Keep lifecycle scripts enabled. Foreground stdio avoids npm creating
      // named pipes that restricted Windows tokens cannot open.
      await runNpm(process.platform === "win32" ? ["ci", "--foreground-scripts"] : ["ci"], stage);
    }
    await run(process.execPath, ["scripts/verify-electron-install.js", "--context", "verify"], { cwd: stage, capture: false });
    await run(process.execPath, ["scripts/generate-mori-assets.js", "--check"], { cwd: stage, capture: false });
    setStageReady(stage);
    const runtime = promoteRuntime(stage);
    stage = null;
    console.log(`Mori Desk is ready: ${runtime}`);
    const readiness = launchReadinessFromSource(inspectRuntimeSource());
    console.log(`次回起動のソース検査: ${readiness.status} (${readiness.reason})。実起動・ログイン起動は未確認です。`);
    console.log("Start with start-windows.bat or npm start. Load the browser extension once, then pair it with Mori Desk.");
  } finally {
    if (stage && fs.existsSync(stage)) {
      try { removeOwned(stage, ["runtime-stage"]); } catch (error) { console.warn(`Failed staging was preserved at ${stage}: ${error.message}`); }
    }
    try { releaseLock(); } catch (error) {
      // Preserve the primary preparation/install error, or a successfully
      // activated runtime, when lock cleanup itself needs manual attention.
      console.warn(`Setup lock was preserved: ${error.message}`);
    }
  }
}

module.exports = { checkNodeVersion, findNpmCli, runNpm, reuseLockedDependencies, setup };
if (require.main === module) Promise.resolve().then(() => {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--reuse-dependencies") || args.length > 1) throw new Error("Unknown setup option.");
  return setup({ reuseDependencies: args.includes("--reuse-dependencies") });
}).catch((error) => {
  console.error(`Mori setup failed: ${error.message}`);
  console.error("An existing verified runtime has not been replaced by an incomplete build.");
  process.exitCode = 1;
});
