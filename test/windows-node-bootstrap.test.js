"use strict";

// This suite intentionally runs the actual BAT bytes under cmd.exe. It does
// not install software globally, assemble Electron, or read user settings.
// Two official ZIP downloads exercise success and a rejected SHA-256 pin.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const LAUNCHERS = [
  "setup-windows.bat", "start-windows.bat", "start-cli-windows.bat",
  "build-windows.bat", "install-node-windows.bat",
];
const SENTINEL = "A previously usable runtime must survive Node preparation.\n";

function sourceBytes(relativePath) {
  if (process.env.GITHUB_ACTIONS === "true" && relativePath.endsWith(".bat")) {
    // checkout can convert text BAT files to CRLF. Read the committed blob so
    // this Windows job also exercises the bytes delivered by GitHub ZIPs.
    const result = spawnSync("git", ["show", `HEAD:${relativePath}`], {
      cwd: ROOT, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, String(result.stderr));
    return result.stdout;
  }
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function makeFixture(parent, label) {
  // The defined percent variable and delayed-expansion variable make unwanted
  // cmd expansion observable, in addition to spaces and an ampersand.
  const root = path.join(parent, `${label} Mori & !bang! %MORI_EXPANSION_TRAP%`);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, ".runtime"));
  fs.mkdirSync(path.join(root, "temp"));
  fs.mkdirSync(path.join(root, "npm-cache"));
  fs.writeFileSync(path.join(root, "npm-user.conf"), "");
  fs.writeFileSync(path.join(root, "npm-global.conf"), "");
  fs.writeFileSync(path.join(root, ".runtime", "sentinel.txt"), SENTINEL);
  for (const name of LAUNCHERS) fs.writeFileSync(path.join(root, name), sourceBytes(name));
  for (const name of ["windows-node.bat", "check-windows-node.js"])
    fs.writeFileSync(path.join(root, "scripts", name), sourceBytes(`scripts/${name}`));
  // Preserve production BAT line endings. GitHub ZIP downloads contain the
  // committed bytes, which must work without a test-only CRLF conversion.
  const probe = `"use strict";
require("fs").appendFileSync("launcher-probe.jsonl", JSON.stringify({
  script: require("path").basename(__filename), args: process.argv.slice(2),
  execPath: process.execPath, cwd: process.cwd(),
  pathFirst: String(process.env.PATH || process.env.Path || "").split(";")[0],
  npm: process.env.npm_execpath,
}) + "\\n");
process.exit(Number(process.env.MORI_TEST_EXIT_CODE || 0));
`;
  fs.writeFileSync(path.join(root, "scripts", "setup.js"), probe);
  fs.writeFileSync(path.join(root, "scripts", "run.js"), probe);
  return root;
}

function fixtureEnv(root, extraPath = [], extra = {}) {
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  assert.ok(systemRoot, "Windows must provide SystemRoot");
  // Allow only OS essentials, not NODE_OPTIONS, npm configuration, tokens, or
  // the runner's Node installations. Nothing changes in the parent process.
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
    PATH: [...extraPath, path.join(systemRoot, "System32"), systemRoot,
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    npm_config_userconfig: path.join(root, "npm-user.conf"),
    npm_config_globalconfig: path.join(root, "npm-global.conf"),
    npm_config_cache: path.join(root, "npm-cache"),
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "AMD64",
    MORI_EXPANSION_TRAP: "UNEXPECTED_PERCENT_EXPANSION",
    bang: "UNEXPECTED_DELAYED_EXPANSION",
    ...extra,
  };
  if (process.env.PROCESSOR_ARCHITEW6432)
    env.PROCESSOR_ARCHITEW6432 = process.env.PROCESSOR_ARCHITEW6432;
  return env;
}

function runBat(root, filename, env, timeout = 30000) {
  // The command itself is a fixed repository-relative BAT name. Special
  // characters enter through cwd and PATH, never through shell interpolation.
  assert.match(filename, /^[a-z-]+\.bat$/);
  const result = spawnSync(env.ComSpec, ["/d", "/v:off", "/s", "/c", filename], {
    cwd: root, env, encoding: "utf8", input: "\r\n\r\n",
    timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout || ""}${result.stderr || ""}` };
}

function probes(root) {
  const file = path.join(root, "launcher-probe.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
}

function canonicalPath(file) {
  // Windows can return the same file as RUNNER~1 or runneradmin depending on
  // whether it came from TEMP, where.exe, or the module loader. Require the
  // same existing filesystem target, not the same spelling of that target.
  return fs.realpathSync.native(file).toLowerCase();
}

function assertRuntimePreserved(root) {
  assert.equal(fs.readFileSync(path.join(root, ".runtime", "sentinel.txt"), "utf8"), SENTINEL);
  assert.deepEqual(fs.readdirSync(path.join(root, ".runtime")), ["sentinel.txt"]);
}

function forbidDownload(root) {
  const file = path.join(root, "scripts", "windows-node.bat");
  const source = fs.readFileSync(file, "utf8");
  assert.ok(source.includes("Invoke-WebRequest -UseBasicParsing -Uri $url"));
  fs.writeFileSync(file, source.replace("Invoke-WebRequest -UseBasicParsing -Uri $url",
    "throw 'TEST: an unexpected download was attempted'; Invoke-WebRequest -UseBasicParsing -Uri $url"));
}

test("Windows Node bootstrap and launcher boundaries", {
  skip: process.platform !== "win32" ? "Requires native Windows cmd.exe and Windows PowerShell" : false,
  timeout: 600000,
}, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mori-node-bootstrap-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
  let nodeDir;

  await t.test("start without Node fails without downloading or changing the runtime", () => {
    const root = makeFixture(temp, "missing");
    forbidDownload(root);
    const result = runBat(root, "start-windows.bat", fixtureEnv(root));
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /Run setup-windows\.bat/);
    assert.doesNotMatch(result.output, /unexpected download|Preparing a private copy/);
    assert.equal(fs.existsSync(path.join(root, ".tools")), false);
    assert.deepEqual(probes(root), []);
    assertRuntimePreserved(root);
  });

  await t.test("Node absent: install the official ZIP and reuse it without another download", () => {
    const root = makeFixture(temp, "download");
    const env = fixtureEnv(root);
    const result = runBat(root, "install-node-windows.bat", env, 240000);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /private Node installation is ready/);
    assert.match(result.output, /v24\.22\.0/);
    const installations = fs.readdirSync(path.join(root, ".tools"));
    assert.equal(installations.length, 1, "The owned download staging must be cleaned up");
    assert.match(installations[0], /^node-v24\.22\.0-win-(x64|arm64)$/);
    nodeDir = path.join(root, ".tools", installations[0]);
    assert.ok(fs.statSync(path.join(nodeDir, "node.exe")).isFile());
    assert.ok(fs.statSync(path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")).isFile());
    assertRuntimePreserved(root);

    // The fixture now actively fails any attempt to enter the download step.
    // Reuse therefore does not depend on reaching nodejs.org a second time.
    forbidDownload(root);
    const again = runBat(root, "install-node-windows.bat", env);
    assert.equal(again.status, 0, again.output);
    assert.doesNotMatch(again.output, /unexpected download|Preparing a private copy/);
    const start = runBat(root, "start-windows.bat", env);
    assert.equal(start.status, 0, start.output);
    const [probe] = probes(root);
    assert.equal(canonicalPath(probe.execPath), canonicalPath(path.join(nodeDir, "node.exe")));
    assert.equal(canonicalPath(probe.pathFirst), canonicalPath(nodeDir));
    assert.equal(canonicalPath(probe.npm), canonicalPath(path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")));
    assert.deepEqual(probe.args, ["start"]);
    assertRuntimePreserved(root);
  });

  if (nodeDir) {
    await t.test("a compatible PATH installation is reused in a path containing spaces, &, ! and %", () => {
      const root = makeFixture(temp, "path-reuse");
      forbidDownload(root);
      const result = runBat(root, "install-node-windows.bat", fixtureEnv(root, [nodeDir]));
      assert.equal(result.status, 0, result.output);
      assert.equal(fs.existsSync(path.join(root, ".tools")), false);
      const start = runBat(root, "start-windows.bat", fixtureEnv(root, [nodeDir]));
      assert.equal(start.status, 0, start.output);
      assert.equal(canonicalPath(probes(root)[0].execPath), canonicalPath(path.join(nodeDir, "node.exe")));
      const quotedPath = runBat(root, "start-windows.bat", fixtureEnv(root, [`"${nodeDir}"`]));
      assert.equal(quotedPath.status, 0, quotedPath.output);
      assert.equal(canonicalPath(probes(root)[1].execPath), canonicalPath(path.join(nodeDir, "node.exe")));
      assertRuntimePreserved(root);
    });

    await t.test("setup, start, CLI and build return the child process failure code", () => {
      const root = makeFixture(temp, "exit-code");
      // Only the setup launcher's dependency-presence check is needed. The
      // fixture setup.js records its invocation and never invokes this stub.
      const support = path.join(root, "support-bin");
      fs.mkdirSync(support);
      fs.writeFileSync(path.join(support, "git.exe"), "fixture presence marker; never executed\n");
      forbidDownload(root);
      const env = fixtureEnv(root, [nodeDir, support], { MORI_TEST_EXIT_CODE: "37" });
      for (const name of LAUNCHERS.filter((name) => name !== "install-node-windows.bat")) {
        const result = runBat(root, name, env);
        assert.equal(result.status, 37, `${name}:\n${result.output}`);
      }
      const seen = probes(root);
      assert.equal(seen.length, 4);
      assert.deepEqual(seen.map(({ script, args }) => ({ script, args })), [
        { script: "setup.js", args: [] },
        { script: "run.js", args: ["start"] },
        { script: "run.js", args: ["start", "--enable-cli"] },
        { script: "run.js", args: ["build:win:x64"] },
      ]);
      assertRuntimePreserved(root);
    });
  }

  await t.test("a wrong SHA-256 pin stops before executing downloaded Node and preserves the runtime", () => {
    const root = makeFixture(temp, "bad-checksum");
    const file = path.join(root, "scripts", "windows-node.bat");
    const source = fs.readFileSync(file, "utf8");
    let replaced = 0;
    fs.writeFileSync(file, source.replace(/MORI_NODE_SHA256=[a-f0-9]{64}/g, () => {
      replaced += 1;
      return `MORI_NODE_SHA256=${"0".repeat(64)}`;
    }));
    assert.equal(replaced, 2, "Both architecture pins must be changed only in this disposable fixture");
    const checker = path.join(root, "scripts", "check-windows-node.js");
    fs.writeFileSync(checker,
      "require('fs').writeFileSync('downloaded-node-was-executed.txt', 'unexpected');\n" + fs.readFileSync(checker, "utf8"));
    const result = runBat(root, "install-node-windows.bat", fixtureEnv(root), 240000);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /SHA-256 mismatch/);
    assert.equal(fs.existsSync(path.join(root, "downloaded-node-was-executed.txt")), false);
    assert.deepEqual(fs.readdirSync(path.join(root, ".tools")), []);
    assert.deepEqual(probes(root), []);
    assertRuntimePreserved(root);
  });
});
