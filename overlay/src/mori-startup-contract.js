"use strict";

// This is a process-local handoff contract, not a network health endpoint.
const RESULT_TYPE = "mori.startup";
const REASONS = new Set(["invalid_arguments", "setup_busy", "source_mismatch", "runtime_unavailable",
  "electron_invalid", "build_invalid", "spawn_failed", "startup_unconfirmed", "development_workspace"]);
const BUILD_ID = /^[a-f0-9]{64}$/;
function failure(reason) {
  const error = new Error(`MORI_STARTUP_${reason.toUpperCase()}`);
  error.code = reason;
  return error;
}
function reasonOf(error) { return REASONS.has(error?.code) ? error.code : "runtime_unavailable"; }
function startupFailureMessage(reason, detail = null) {
  if (reason === "development_workspace") return "この作業場所は計測開発専用です。通常の Mori Desk は常用側の start-windows.bat から起動してください。";
  if (reason === "source_mismatch") {
    const cause = detail?.reason === "source_update_pending"
      ? "ソース更新が本体へ未反映のため、起動を保留しています。"
      : detail?.reason === "runtime_artifact_mismatch"
        ? "準備済み本体のファイルが構築時のソースと一致しないため、起動を保留しています。"
        : "ソースと準備済み本体の整合性を確認できないため、起動を保留しています。";
    const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000 ? n : "不明";
    const id = value => /^[a-f0-9]{64}$/.test(value || "") ? value.slice(0,12) : "不明";
    return cause + (detail ? `\n変更 ${count(detail.changedFiles)} 件・未追加 ${count(detail.missingFiles)} 件。構築 ${id(detail.builtBuildId)} / 現在 ${id(detail.currentBuildId)}。` : "")
      + "\nsetup-windows.bat で再構築してください。詳細確認: check-windows.bat。保存済みデータは初期化していません。";
  }
  return `本体の起動を確認できませんでした（${REASONS.has(reason) ? reason : "runtime_unavailable"}）。\n`
    + "起動中の Mori とセットアップの状態を確認し、通常の setup-windows.bat と起動手順で修復してください。保存済みデータは初期化していません。";
}
function parseStartupArgs(argv, { strict = false } = {}) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== "string")) throw failure("invalid_arguments");
  let reason = "manual", seen = false, cli = false;
  for (const arg of argv) {
    if (arg.startsWith("--mori-startup=")) {
      if (seen || !["--mori-startup=manual", "--mori-startup=login"].includes(arg)) throw failure("invalid_arguments");
      seen = true; reason = arg.slice("--mori-startup=".length);
    } else if (arg === "--enable-cli") {
      if (cli) throw failure("invalid_arguments");
      cli = true;
    } else if (strict) throw failure("invalid_arguments");
  }
  if (reason === "login" && cli) throw failure("invalid_arguments");
  return Object.freeze({ reason, cli, isLogin: reason === "login" });
}
function validBuildInfo(value, version) {
  return value && !Array.isArray(value) && Object.keys(value).sort().join(",") === "buildId,observerContract,product,schema,version"
    && value.schema === 1 && value.product === "mori-desk" && value.observerContract === 1
    && typeof value.version === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(value.version)
    && (version === undefined || value.version === version) && typeof value.buildId === "string" && BUILD_ID.test(value.buildId);
}
function makeResult(status, buildId, reason = null) {
  return { type: RESULT_TYPE, v: 1, status, buildId, reason };
}
function validResult(value, expectedBuildId) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "buildId,reason,status,type,v") return false;
  try { if (Buffer.byteLength(JSON.stringify(value)) > 1024) return false; }
  catch { return false; }
  if (value.type !== RESULT_TYPE || value.v !== 1) return false;
  if (value.status === "blocked") return REASONS.has(value.reason) && (value.buildId === null || value.buildId === expectedBuildId);
  return ["started", "redirected_unknown"].includes(value.status) && value.reason === null
    && typeof expectedBuildId === "string" && BUILD_ID.test(expectedBuildId) && value.buildId === expectedBuildId;
}
function createReporter(processObject, buildInfo) {
  let sent = false;
  const hasParent = typeof processObject.send === "function";
  return {
    hasParent,
    async report(status, reason = null) {
      if (sent) return false;
      sent = true;
      if (!hasParent || processObject.connected === false) return false;
      const result = makeResult(status, buildInfo?.buildId || null, reason);
      return new Promise(resolve => {
        let done = false;
        const finish = ok => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
        const timer = setTimeout(() => finish(false), 500);
        try { processObject.send(result, error => finish(!error)); }
        catch { finish(false); }
      });
    },
  };
}
function waitForStartup(child, expectedBuildId, { timeoutMs = 15000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      // Keep the error handler attached until the parent exits: a late spawn
      // error must not turn a bounded, already classified result into a crash.
      resolve(result);
    };
    const onMessage = value => { if (validResult(value, expectedBuildId)) finish(value); };
    const onExit = () => finish(makeResult("startup_unconfirmed", expectedBuildId, "startup_unconfirmed"));
    const onError = () => finish(makeResult("blocked", expectedBuildId, "spawn_failed"));
    const timer = setTimeout(onExit, timeoutMs);
    child.on("message", onMessage); child.once("exit", onExit); child.on("error", onError);
  });
}
module.exports = { failure, reasonOf, startupFailureMessage, parseStartupArgs, validBuildInfo, makeResult, validResult, createReporter, waitForStartup };
