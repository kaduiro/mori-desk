"use strict";

// CI package smoke only. This checks an actual macOS executable on a macOS
// runner; it does not substitute for a signed install or interactive HUD test.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { requireRuntime } = require("./prepare-runtime");

function main() {
  assert.equal(process.platform, "darwin", "macOS runner required");
  const arch = process.env.MORI_ARCH;
  assert.ok(["arm64", "x64"].includes(arch), "MORI_ARCH must be arm64 or x64");
  assert.equal(process.arch, arch, "runner architecture must match package");
  const dist = path.join(requireRuntime(), "dist");
  const version = require("../package.json").version;
  const prefix = `Mori-Desk-${version}-${arch}`;
  for (const ext of ["dmg", "zip"]) {
    const file = path.join(dist, `${prefix}.${ext}`);
    assert.ok(fs.statSync(file).size > 1024, `missing or empty ${file}`);
    const args = ext === "dmg" ? ["verify", file] : ["-t", file];
    const command = ext === "dmg" ? "hdiutil" : "unzip";
    const checked = spawnSync(command, args, { encoding: "utf8", timeout: 120000 });
    assert.equal(checked.status, 0, `${command} ${args.join(" ")} failed: ${checked.stderr}`);
  }
  const appDir = arch === "x64" ? "mac" : "mac-arm64";
  const executable = path.join(dist, appDir, "Mori Desk.app", "Contents", "MacOS", "Mori Desk");
  assert.ok(fs.statSync(executable).isFile(), `missing ${executable}`);
  const launched = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 30000 });
  assert.equal(launched.status, 0, `packaged executable did not start: ${launched.stderr}`);
  assert.match(launched.stdout, /\d+\.\d+\.\d+/, "packaged executable did not report a version");
  console.log(`Verified unsigned macOS ${arch} DMG, ZIP, and executable launch.`);
}

if (require.main === module) main();
module.exports = { main };
