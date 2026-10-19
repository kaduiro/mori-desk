"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { requireRuntime, run } = require("./prepare-runtime");
const { checkNodeVersion, runNpm } = require("./setup");

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
  if (!["start", "test", "verify:electron", "build:win:x64"].includes(command)) throw new Error(`Unknown Mori command: ${command}`);
  const runtime = requireRuntime();
  if (command === "start") {
    const launchArgs = args.slice(1);
    if (launchArgs.some((arg) => arg !== "--enable-cli")) throw new Error("The source preview launcher accepts only --enable-cli.");
    if (launchArgs.includes("--enable-cli")) console.log("CLI mode: close the original Clawd on Desk first. This preview does not automatically migrate its settings.");
    await run(process.execPath, [path.join(runtime, "launch.js"), ...launchArgs], { cwd: runtime, capture: false });
  } else if (command === "test") {
    const files = testFiles(runtime);
    console.log(`Running ${files.length} browser/Mori test files.`);
    await run(process.execPath, ["--test", ...files], { cwd: runtime, capture: false });
  } else if (command === "verify:electron") {
    await run(process.execPath, ["scripts/verify-electron-install.js", "--context", "verify"], { cwd: runtime, capture: false });
  } else {
    if (process.platform !== "win32") throw new Error("Run build:win:x64 on Windows for this development preview. Mac packaging needs a separate Mac runner.");
    await runNpm(["run", "build:win:x64"], runtime);
    console.log(`Windows installer output: ${path.join(runtime, "dist")}`);
  }
}

module.exports = { testFiles, main };
if (require.main === module) main().catch((error) => { console.error(`Mori Desk: ${error.message}`); process.exitCode = 1; });
