"use strict";

// Read disk artifacts only. This does not contact Chrome, the desktop bridge,
// provider pages, GitHub, or a user profile, and never starts recovery/setup.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOT, RUNTIME, assertSafePath, inspectRuntimeSource, run } = require("./prepare-runtime");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
function versionIn(data) {
  try {
    const value = JSON.parse(data.toString("utf8")).version;
    return typeof value === "string" && /^\d+\.\d+\.\d+(?:\.\d+|-[a-zA-Z0-9.-]+)?$/.test(value) && value.length <= 64 ? value : null;
  } catch { return null; }
}

function checkDirectory(dir) {
  const relative = path.relative(ROOT, dir);
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) assertSafePath(dir);
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("extension_directory_invalid");
}

function extensionFiles(dir, prefix = "") {
  checkDirectory(dir);
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("extension_symlink");
    if (entry.isDirectory()) files.push(...extensionFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error("extension_file_invalid");
  }
  return files;
}

function readFileWithin(dir, relative) {
  checkDirectory(dir);
  let current = dir;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("extension_symlink");
  }
  if (!fs.lstatSync(current).isFile()) throw new Error("extension_file_invalid");
  // Check the opened descriptor as well. NONBLOCK prevents a replaced FIFO
  // from hanging this read-only diagnostic; unsupported flags are zero.
  const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("extension_file_invalid");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function packageAt(dir) {
  try { return JSON.parse(readFileWithin(dir, "package.json").toString("utf8")); }
  catch { return null; }
}

function inspectExtension(dir, sourceDir, expectedFiles) {
  const result = { path: dir, version: null,
    checkedFiles: expectedFiles.length, changed: [], missing: [], unreadable: [], fingerprint: null,
    coverage: "expected_source_files_only", liveBrowser: "NOT_CHECKED" };
  const entries = [];
  try {
    checkDirectory(dir);
  } catch {
    result.status = "unavailable";
    return result;
  }
  for (const relative of expectedFiles) {
    try {
      const data = readFileWithin(dir, relative);
      if (relative === "manifest.json") result.version = versionIn(data);
      if (!data.equals(readFileWithin(sourceDir, relative))) result.changed.push(relative);
      entries.push({ path: relative, bytes: data.length, sha256: sha256(data) });
    } catch (error) {
      (error.code === "ENOENT" ? result.missing : result.unreadable).push(relative);
    }
  }
  if (!result.missing.length && !result.unreadable.length) result.fingerprint = sha256(JSON.stringify(entries));
  result.status = result.missing.length || result.unreadable.length || result.changed.length ? "mismatch" : "matches_source";
  return result;
}

async function gitIdentity() {
  const read = args => run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args]);
  try {
    const top = (await read(["rev-parse", "--show-toplevel"])).toString("utf8").trim();
    if (fs.realpathSync(top) !== ROOT) throw new Error("not_this_checkout");
    const commit = (await read(["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
    const dirty = (await read(["status", "--porcelain", "--untracked-files=no"])).length > 0;
    return { commit: /^[a-f0-9]{40}$/.test(commit) ? commit : null, trackedChanges: dirty,
      remoteFreshness: "NOT_CHECKED", untrackedFiles: "NOT_CHECKED" };
  } catch { return { commit: null, trackedChanges: null, remoteFreshness: "NOT_CHECKED", untrackedFiles: "NOT_CHECKED" }; }
}

async function collectReport({ extensionDir } = {}) {
  const sourceDir = path.join(ROOT, "overlay", "extensions", "browser-bridge");
  const files = extensionFiles(sourceDir);
  let source;
  try { source = { status: "checked", ...inspectRuntimeSource() }; }
  catch { source = { status: "unavailable" }; }
  const sourceMatches = source.status === "checked" && source.ready && source.upstreamMatches && source.inputMatches
    && source.overlay.changed.length === 0 && source.overlay.missing.length === 0;
  const runtime = inspectExtension(path.join(RUNTIME, "extensions", "browser-bridge"), sourceDir, files);
  const selected = extensionDir ? inspectExtension(path.resolve(extensionDir), sourceDir, files) : null;
  const checkoutPackage = packageAt(ROOT), runtimePackage = packageAt(RUNTIME);
  const productIdentityMatches = runtimePackage?.name === "mori-desk"
    && runtimePackage?.build?.appId === "com.kaduiro.moridesk" && runtimePackage?.build?.publish === null;
  let sourceVersion = null;
  try { sourceVersion = versionIn(readFileWithin(sourceDir, "manifest.json")); } catch { /* Unavailable, never guess. */ }
  const packageVersion = pkg => pkg ? versionIn(Buffer.from(JSON.stringify(pkg))) : null;
  return {
    schemaVersion: 1, diagnostic: "mori-disk-versions-v1", checkedAt: new Date().toISOString(),
    checkout: { ...await gitIdentity(), applicationVersion: packageVersion(checkoutPackage), extensionVersion: sourceVersion },
    runtime: { applicationVersion: packageVersion(runtimePackage), productIdentityMatches, source,
      sourceMatches, extension: runtime, inheritedRuntimeFiles: "NOT_CHECKED", runningDesktop: "NOT_CHECKED" },
    selectedExtension: selected,
    diskChecksPassed: sourceMatches && productIdentityMatches && runtime.status === "matches_source" && (!selected || selected.status === "matches_source"),
    browserLoadedExtension: "NOT_CHECKED", providerAcceptance: "NOT_CHECKED", automaticRecovery: "NOT_CHECKED",
  };
}

function printReport(report) {
  const result = value => value ? "一致" : "要確認";
  console.log("MORI Desk — ディスク上の版の確認");
  console.log(`checkout: ${report.checkout.commit || "Git情報なし"}${report.checkout.trackedChanges ? "（変更あり）" : ""}`);
  console.log(`ソース: 本体 ${report.checkout.applicationVersion || "不明"} / 拡張 ${report.checkout.extensionVersion || "不明"}`);
  console.log(`準備済み本体: ${report.runtime.applicationVersion || "不明"} / 拡張 ${report.runtime.extension.version || "不明"}`);
  console.log(`ソース入力と準備済みファイル: ${result(report.runtime.sourceMatches)}`);
  console.log(`準備済み本体の製品設定: ${result(report.runtime.productIdentityMatches)}`);
  console.log(`runtime の拡張フォルダー: ${report.runtime.extension.path}`);
  console.log(`runtime の拡張ファイル: ${report.runtime.extension.status}`);
  if (report.selectedExtension) {
    console.log(`指定した拡張フォルダー: ${report.selectedExtension.path}`);
    console.log(`指定した拡張: ${report.selectedExtension.version || "不明"} / ${report.selectedExtension.status}`);
  }
  if (!report.runtime.sourceMatches) console.log("ソース更新後は setup-windows.bat（または npm run setup）で本体を再構築してください。");
  if (report.selectedExtension && report.selectedExtension.status !== "matches_source")
    console.log("指定フォルダーとソースが一致していません。Chrome の拡張機能の詳細で、読み込み元を確認してください。");
  console.log("Chrome が実際に実行中の版、本体プロセス、実サービスの監視・自動復旧は未確認です。");
  console.log("Chrome の拡張機能の詳細にある版と読み込み元を、この結果と照合してください。");
  console.log("この確認はネット接続・ページ読取り・再接続・再読み込み・ファイル変更を行いません。継承コード全体の検証でもありません。");
}

async function main(args = process.argv.slice(2)) {
  let json = false, extensionDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--extension-dir" && args[i + 1] && !args[i + 1].startsWith("--")) extensionDir = args[++i];
    else if (args[i] === "--help") {
      console.log("node scripts/doctor.js [--json] [--extension-dir <Chromeの読み込み元フォルダー>]");
      return 0;
    } else throw new Error("Usage: node scripts/doctor.js [--json] [--extension-dir <folder>]");
  }
  const report = await collectReport({ extensionDir });
  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return report.diskChecksPassed ? 0 : 2;
}

module.exports = { collectReport, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => {
  console.error("MORI_SOURCE_CHECK_FAILED: 版の確認を完了できませんでした。ファイルは変更していません。--help で引数を確認してください。");
  process.exitCode = 1;
});
