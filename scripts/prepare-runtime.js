"use strict";

// Builds a pinned source tree in an owned staging directory. No npm install or
// replacement of the usable runtime happens here; setup.js owns that transaction.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = fs.realpathSync(path.resolve(__dirname, ".."));
const RUNTIME = path.join(ROOT, ".runtime");
const MARKER = ".mori-owned.json";
const UPSTREAM_URL = "https://github.com/rullerzhou-afk/clawd-on-desk.git";
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const EXCLUDED_ROOTS = new Set([".git", ".github", "node_modules", "assets", "themes"]);
const ART_EXTENSIONS = /\.(?:svg|png|jpe?g|gif|apng|webp|avif|ico|icns|mp3|wav|ogg|mp4|mov|webm|pdf|zip|woff2?|ttf|otf)$/i;

function isMissing(error) { return error && error.code === "ENOENT"; }

function assertSafePath(target) {
  const full = path.resolve(target);
  const rel = path.relative(ROOT, full);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel))
    throw new Error(`Refusing a path outside the Mori project: ${full}`);
  let current = ROOT;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing a symbolic link in a generated path: ${current}`);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return full;
}

function readRegularFile(file) {
  assertSafePath(file);
  if (!fs.lstatSync(file).isFile()) throw new Error("Expected a regular Mori source file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Expected a regular Mori source file.");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function readJson(file) { return JSON.parse(readRegularFile(file).toString("utf8")); }

function readLock() {
  const lock = readJson(path.join(ROOT, "upstream.lock.json"));
  if (lock.schemaVersion !== 1 || lock.project !== "mori-desk"
      || lock.repository !== UPSTREAM_URL || !/^[a-f0-9]{40}$/.test(lock.commit || ""))
    throw new Error("upstream.lock.json must identify the reviewed repository and a full 40-character commit SHA.");
  return lock;
}

function markerFor(kind, fields = {}) {
  return { schemaVersion: 1, project: "mori-desk", projectRoot: ROOT, kind, ...fields };
}

function writeMarker(dir, value) {
  assertSafePath(dir);
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function requireOwner(dir, kinds) {
  assertSafePath(dir);
  const markerFile = path.join(dir, MARKER);
  assertSafePath(markerFile);
  let value;
  try {
    if (!fs.lstatSync(markerFile).isFile()) throw new Error("not a regular marker file");
    value = readJson(markerFile);
  } catch (error) { throw new Error(`Generated directory has no readable Mori ownership marker: ${dir} (${error.message})`); }
  if (value.schemaVersion !== 1 || value.project !== "mori-desk" || value.projectRoot !== ROOT || !kinds.includes(value.kind))
    throw new Error(`Generated directory ownership does not match this project: ${dir}`);
  return value;
}

function removeOwned(dir, kinds) {
  requireOwner(dir, kinds);
  const rel = path.relative(ROOT, dir).replace(/\\/g, "/");
  if (!/^\.runtime-(?:stage|backup)-[a-f0-9-]+$/.test(rel)
      && !/^\.upstream\/\.clawd-stage-[a-f0-9-]+$/.test(rel)
      && rel !== ".mori-setup-lock")
    throw new Error(`Refusing to recursively remove a non-staging path: ${dir}`);
  fs.rmSync(dir, { recursive: true });
}

function childEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) delete env[key];
  }
  return env;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture !== false;
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: [options.input ? "pipe" : "ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    });
    const chunks = []; let length = 0; let stderr = ""; let failed = false;
    const fail = (error) => { if (!failed) { failed = true; reject(error); } };
    child.on("error", fail);
    if (capture) {
      child.stdout.on("data", (chunk) => {
        length += chunk.length;
        if (length > (options.maxBytes || 8 * 1024 * 1024)) {
          child.kill(); fail(new Error(`${command} output exceeded the expected source limit.`)); return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk) => { if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8"); });
    }
    if (options.input) {
      child.stdin.on("error", (error) => { if (error.code !== "EPIPE") fail(error); });
      child.stdin.end(options.input);
    }
    child.on("close", (code, signal) => {
      if (failed) return;
      if (code !== 0) {
        const detail = stderr.trim();
        fail(new Error(`${path.basename(command)} failed (${signal || code}).${detail ? `\n${detail}` : ""}`));
        return;
      }
      resolve(capture ? Buffer.concat(chunks) : Buffer.alloc(0));
    });
  });
}

async function git(args, cwd, options = {}) {
  // Do not run the developer's global Git hook templates while preparing a cache.
  return run("git", ["-c", "core.hooksPath=", "-c", "init.templateDir=", ...args], { cwd, ...options });
}

async function gitText(args, cwd) { return (await git(args, cwd)).toString("utf8").trim(); }

function normalizeOrigin(url) { return String(url).trim().replace(/\/$/, "").replace(/\.git$/, ""); }

async function verifyCache(cache, lock) {
  requireOwner(cache, ["upstream-cache"]);
  const origin = await gitText(["remote", "get-url", "origin"], cache);
  if (normalizeOrigin(origin) !== normalizeOrigin(lock.repository)) throw new Error("The upstream cache origin differs from upstream.lock.json; it was not used.");
  const top = fs.realpathSync(await gitText(["rev-parse", "--show-toplevel"], cache));
  if (top !== fs.realpathSync(cache)) throw new Error("The upstream cache is not an independent Git worktree.");
}

async function ensureUpstream(lock) {
  const parent = assertSafePath(path.join(ROOT, ".upstream"));
  const cache = assertSafePath(path.join(parent, "clawd-on-desk"));
  fs.mkdirSync(parent, { recursive: true });
  if (!fs.existsSync(cache)) {
    const stage = assertSafePath(path.join(parent, `.clawd-stage-${crypto.randomUUID()}`));
    fs.mkdirSync(stage);
    writeMarker(stage, markerFor("upstream-cache"));
    try {
      await git(["init", "--quiet"], stage);
      await git(["remote", "add", "origin", lock.repository], stage);
      console.log(`Downloading reviewed upstream commit ${lock.commit.slice(0, 12)}...`);
      await git(["fetch", "--depth=1", "--no-tags", "origin", lock.commit], stage, { capture: false });
      await git(["update-ref", "refs/heads/pinned", lock.commit], stage);
      await git(["symbolic-ref", "HEAD", "refs/heads/pinned"], stage);
      fs.renameSync(stage, cache);
    } catch (error) {
      try { removeOwned(stage, ["upstream-cache"]); } catch (cleanup) { console.warn(`Preserved failed cache staging: ${stage}\n${cleanup.message}`); }
      throw error;
    }
  }
  await verifyCache(cache, lock);
  let known;
  try { known = await gitText(["cat-file", "-t", lock.commit], cache); } catch { known = ""; }
  if (known !== "commit") {
    console.log(`Fetching pinned upstream commit ${lock.commit.slice(0, 12)}...`);
    await git(["fetch", "--depth=1", "--no-tags", "origin", lock.commit], cache, { capture: false });
  }
  if (await gitText(["rev-parse", `${lock.commit}^{commit}`], cache) !== lock.commit)
    throw new Error("The downloaded commit does not match upstream.lock.json.");
  return cache;
}

function sourcePathAllowed(name) {
  if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").some((x) => !x || x === "." || x === "..")) return false;
  const parts = name.split("/");
  if (EXCLUDED_ROOTS.has(parts[0]) || /^readme(?:\.|$)/i.test(parts[0])) return false;
  return !ART_EXTENSIONS.test(name);
}

async function copyPinnedSource(cache, commit, stage) {
  const tree = (await git(["ls-tree", "-rz", "--full-tree", commit], cache)).toString("utf8").split("\0").filter(Boolean);
  const entries = [];
  for (const line of tree) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Unexpected Git tree entry.");
    const [, mode, type, oid, name] = match;
    if (!sourcePathAllowed(name)) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`Unsupported upstream link or submodule: ${name}`);
    entries.push({ mode, oid, name });
  }
  if (!entries.length || entries.length > 20000) throw new Error("Unexpected upstream source file count.");
  // Read actual Git blobs, never a mutable checkout or untracked cache files.
  const batch = await git(["cat-file", "--batch"], cache, {
    input: entries.map((e) => e.oid).join("\n") + "\n", maxBytes: MAX_SOURCE_BYTES,
  });
  let cursor = 0;
  for (const entry of entries) {
    const end = batch.indexOf(10, cursor);
    if (end === -1) throw new Error("Incomplete Git source response.");
    const header = batch.subarray(cursor, end).toString("ascii");
    const parsed = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!parsed || parsed[1] !== entry.oid) throw new Error(`Unexpected blob response for ${entry.name}`);
    const size = Number(parsed[2]); cursor = end + 1;
    if (!Number.isSafeInteger(size) || cursor + size >= batch.length) throw new Error("Invalid source blob length.");
    const data = batch.subarray(cursor, cursor + size);
    const actual = crypto.createHash("sha1").update(`blob ${size}\0`).update(data).digest("hex");
    if (actual !== entry.oid || batch[cursor + size] !== 10) throw new Error(`Source blob integrity failure: ${entry.name}`);
    const destination = assertSafePath(path.join(stage, entry.name));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    cursor += size + 1;
  }
  if (cursor !== batch.length) throw new Error("Unexpected trailing Git source data.");
  console.log(`Copied ${entries.length} pinned source files; upstream artwork excluded.`);
}

function listOverlay(dir, relative = "") {
  const result = [];
  assertSafePath(dir);
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.name === ".git" || item.name === "node_modules" || item.name === MARKER) throw new Error(`Reserved overlay path: ${name}`);
    const file = assertSafePath(path.join(dir, item.name));
    if (item.isSymbolicLink()) throw new Error(`Overlay symlinks are not supported: ${name}`);
    if (item.isDirectory()) result.push(...listOverlay(file, name));
    else if (item.isFile()) result.push({ name, file });
    else throw new Error(`Unsupported overlay file: ${name}`);
  }
  return result;
}

function inputFingerprint(lock = readLock(), files = listOverlay(path.join(ROOT, "overlay"))) {
  const patch = assertSafePath(path.join(ROOT, "patches", "mori.patch"));
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(lock)).update(readRegularFile(patch));
  for (const entry of files) fingerprint.update(entry.name).update("\0").update(readRegularFile(entry.file));
  return fingerprint.digest("hex");
}

function inspectRuntimeSource() {
  const marker = requireOwner(RUNTIME, ["runtime"]);
  const lock = readLock();
  const files = listOverlay(path.join(ROOT, "overlay"));
  const current = inputFingerprint(lock, files);
  const changed = [], missing = [];
  for (const entry of files) {
    const target = assertSafePath(path.join(RUNTIME, entry.name));
    try {
      if (!fs.lstatSync(target).isFile() || !readRegularFile(target).equals(readRegularFile(entry.file))) changed.push(entry.name);
    } catch (error) {
      if (isMissing(error)) missing.push(entry.name);
      else throw error;
    }
  }
  return {
    ready: marker.ready === true,
    upstreamMatches: marker.upstreamCommit === lock.commit,
    inputMatches: marker.inputFingerprint === current,
    currentInputFingerprint: current,
    builtInputFingerprint: /^[a-f0-9]{64}$/.test(marker.inputFingerprint || "") ? marker.inputFingerprint : null,
    overlay: { checked: files.length, changed, missing },
  };
}

async function prepareRuntime() {
  const lock = readLock();
  const patch = assertSafePath(path.join(ROOT, "patches", "mori.patch"));
  const overlay = assertSafePath(path.join(ROOT, "overlay"));
  if (!fs.statSync(patch).isFile() || !fs.readFileSync(patch).length) throw new Error("The reviewed patches/mori.patch is missing or empty.");
  const overlayFiles = listOverlay(overlay);
  if (!overlayFiles.length) throw new Error("The Mori source overlay is empty.");
  const cache = await ensureUpstream(lock);
  const stage = assertSafePath(path.join(ROOT, `.runtime-stage-${crypto.randomUUID()}`));
  fs.mkdirSync(stage);
  writeMarker(stage, markerFor("runtime-stage", { upstreamCommit: lock.commit, ready: false }));
  try {
    await copyPinnedSource(cache, lock.commit, stage);
    // An independent .git prevents git apply from finding the parent delivery repo.
    await git(["init", "--quiet"], stage);
    await git(["apply", "--check", "--whitespace=nowarn", patch], stage);
    await git(["apply", "--whitespace=nowarn", patch], stage);
    requireOwner(stage, ["runtime-stage"]);
    const gitDir = assertSafePath(path.join(stage, ".git"));
    fs.rmSync(gitDir, { recursive: true });
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(lock)).update(fs.readFileSync(patch));
    for (const entry of overlayFiles) {
      const target = assertSafePath(path.join(stage, entry.name));
      const data = fs.readFileSync(entry.file);
      fingerprint.update(entry.name).update("\0").update(data);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    const pkg = readJson(path.join(stage, "package.json"));
    if (pkg.name !== "mori-desk" || pkg.build?.appId !== "com.kaduiro.moridesk" || pkg.build?.publish !== null || pkg.build?.nsis?.include)
      throw new Error("The reviewed Mori product/update/uninstaller isolation patch is incomplete.");
    await run(process.execPath, ["scripts/generate-mori-assets.js"], { cwd: stage, capture: false });
    await run(process.execPath, ["scripts/generate-mori-assets.js", "--check"], { cwd: stage, capture: false });
    writeMarker(stage, markerFor("runtime-stage", {
      upstreamCommit: lock.commit, inputFingerprint: fingerprint.digest("hex"), version: pkg.version, ready: false,
    }));
    return stage;
  } catch (error) {
    try { removeOwned(stage, ["runtime-stage"]); } catch (cleanup) { console.warn(`Preserved failed runtime staging: ${stage}\n${cleanup.message}`); }
    throw error;
  }
}

function setStageReady(stage) {
  const marker = requireOwner(stage, ["runtime-stage"]);
  writeMarker(stage, { ...marker, ready: true, preparedAt: new Date().toISOString() });
}

function promoteRuntime(stage) {
  const marker = requireOwner(stage, ["runtime-stage"]);
  if (marker.ready !== true) throw new Error("Refusing to activate an unverified runtime.");
  assertSafePath(RUNTIME);
  let backup = null;
  if (fs.existsSync(RUNTIME)) {
    requireOwner(RUNTIME, ["runtime"]);
    backup = assertSafePath(path.join(ROOT, `.runtime-backup-${crypto.randomUUID()}`));
    fs.renameSync(RUNTIME, backup);
  }
  try {
    writeMarker(stage, { ...marker, kind: "runtime" });
    fs.renameSync(stage, RUNTIME);
  } catch (error) {
    try {
      if (fs.existsSync(stage)) writeMarker(stage, { ...marker, kind: "runtime-stage" });
      if (backup && !fs.existsSync(RUNTIME)) fs.renameSync(backup, RUNTIME);
    } catch (restore) { console.error(`Previous runtime is preserved at ${backup}. Restore could not finish: ${restore.message}`); }
    throw error;
  }
  if (backup) {
    try { removeOwned(backup, ["runtime"]); } catch (error) { console.warn(`New runtime is ready. Previous runtime retained at ${backup}: ${error.message}`); }
  }
  return RUNTIME;
}

function requireRuntime() {
  const marker = requireOwner(RUNTIME, ["runtime"]);
  if (marker.ready !== true || marker.upstreamCommit !== readLock().commit)
    throw new Error("The runtime is missing, incomplete or uses a different upstream pin. Run npm run setup first.");
  const pkg = readJson(path.join(RUNTIME, "package.json"));
  if (pkg.name !== "mori-desk" || pkg.build?.appId !== "com.kaduiro.moridesk" || pkg.build?.publish !== null)
    throw new Error("The runtime product identity is not the expected Mori Desk preview.");
  const source = inspectRuntimeSource();
  if (!source.inputMatches || source.overlay.changed.length || source.overlay.missing.length)
    throw new Error("MORI_RUNTIME_SOURCE_MISMATCH: The prepared app differs from this checkout. Run setup-windows.bat (or npm run setup) before starting or testing. Your existing runtime and data have been preserved. Chrome's loaded extension must be checked separately.");
  return RUNTIME;
}

function acquireSetupLock() {
  const dir = assertSafePath(path.join(ROOT, ".mori-setup-lock"));
  const token = crypto.randomUUID();
  try { fs.mkdirSync(dir); } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another setup may be running (.mori-setup-lock exists). Finish that setup first; see docs/windows-ja.md for a stale lock.");
    throw error;
  }
  writeMarker(dir, markerFor("setup-lock", { token, pid: process.pid }));
  return () => {
    const current = requireOwner(dir, ["setup-lock"]);
    if (current.token !== token) throw new Error("The setup lock changed owner; it was preserved.");
    removeOwned(dir, ["setup-lock"]);
  };
}

module.exports = {
  ROOT, RUNTIME, readLock, run, assertSafePath, requireOwner, removeOwned,
  sourcePathAllowed, prepareRuntime, setStageReady, promoteRuntime,
  requireRuntime, acquireSetupLock, inputFingerprint, inspectRuntimeSource,
};

if (require.main === module) {
  console.log("This is the preparation helper. Run npm run setup to prepare, verify and activate Mori Desk.");
  process.exitCode = 1;
}
