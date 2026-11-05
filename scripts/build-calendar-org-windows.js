"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, requireRuntime } = require("./prepare-runtime");
const { readClientConfig } = require("../overlay/src/mori-calendar-client-config");

function outsideRoot(target, root = ROOT) {
  const physical = value => {
    let current = path.resolve(value);
    const trailing = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Cannot resolve build path.");
      trailing.unshift(path.basename(current));
      current = parent;
    }
    return path.join(fs.realpathSync(current), ...trailing);
  };
  const relative = path.relative(physical(root), physical(target));
  return relative !== "" && (relative === ".." || relative.startsWith(".." + path.sep)
    || path.isAbsolute(relative));
}

function buildOptions({ runtime, clientFile, outputDir }) {
  const source = path.resolve(clientFile), output = path.resolve(outputDir);
  if (!outsideRoot(source) || !outsideRoot(output)) throw new Error("Keep organization credentials and output outside the source repository.");
  const client = readClientConfig(source, fs, { requireSecret: true });
  if (!client.clientSecret) throw new Error("The Desktop OAuth secret is missing.");
  const pkg = JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8"));
  if (pkg.name !== "mori-desk" || !pkg.build || pkg.build.appId !== "com.kaduiro.moridesk")
    throw new Error("The verified Mori Desk product metadata is unavailable.");
  const config = { ...pkg.build,
    directories: { ...pkg.build.directories, output },
    extraResources: [...(pkg.build.extraResources || []), { from: source, to: "mori-calendar-client.json" }],
  };
  return { source, output, config };
}

async function main(args = process.argv.slice(2)) {
  const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const clientFile = value("--client-json"), outputDir = value("--output");
  const dryRun = args.includes("--dry-run");
  if (!clientFile || !outputDir || args.some((arg, index) =>
    !["--client-json", "--output", "--dry-run"].includes(arg) && !["--client-json", "--output"].includes(args[index - 1])))
    throw new Error("Usage: node scripts/build-calendar-org-windows.js --client-json <Desktop JSON> --output <private directory> [--dry-run]");
  if (process.platform !== "win32") throw new Error("Build the Windows package on Windows.");
  const runtime = requireRuntime();
  const options = buildOptions({ runtime, clientFile, outputDir });
  if (dryRun) { console.log("Mori Desk organization Desktop OAuth configuration: valid. No package was built."); return; }
  fs.mkdirSync(options.output, { recursive: true });
  const builder = require(path.join(runtime, "node_modules", "electron-builder"));
  const previousDir = process.cwd();
  let artifacts;
  try {
    process.chdir(runtime);
    artifacts = await builder.build({ projectDir: runtime,
      targets: builder.Platform.WINDOWS.createTarget(["nsis"], builder.Arch.x64),
      config: options.config, publish: "never" });
  } finally { process.chdir(previousDir); }
  if (!artifacts.length) throw new Error("The installer build produced no artifact.");
  const packagedConfig = path.join(options.output, "win-unpacked", "resources", "mori-calendar-client.json");
  if (!fs.existsSync(packagedConfig)
    || readClientConfig(packagedConfig, fs, { requireSecret: true }).clientId !== readClientConfig(options.source, fs, { requireSecret: true }).clientId)
    throw new Error("The organization OAuth configuration was not included in the package.");
  console.log(`Mori Desk organization installer built in: ${options.output}`);
  console.log("Verify the actual installer, signature, OS trust, and organization settings before distribution.");
}

module.exports = { outsideRoot, buildOptions, main };
if (require.main === module) main().catch(error => {
  console.error(`Mori Desk organization build: ${error.message}`);
  process.exit(1);
});
