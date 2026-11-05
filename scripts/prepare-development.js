"use strict";

// Owned, independent source copy for uncommitted measurement development.
// No hardlinks, profile data, reports, OS registration or production promotion.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const prepare = require("./prepare-runtime");
const { ROOT, RUNTIME, assertSafePath, requireOwner, requireRuntime, inputFingerprint, acquireSetupLock } = prepare;
const DEVELOPMENT_MARKER = ".mori-development.json";

function requireDevelopmentWorkspace() {
  const file = assertSafePath(path.join(ROOT, DEVELOPMENT_MARKER));
  let m;
  try { m = JSON.parse(fs.readFileSync(file,"utf8")); } catch {}
  if (!m || m.schemaVersion !== 1 || m.project !== "mori-desk" || m.kind !== "development-workspace" || !m.ready
    || m.projectRoot !== ROOT || !/^workspace-[a-f0-9-]{36}$/.test(path.basename(ROOT))
    || path.basename(path.dirname(ROOT)) !== ".development" || m.productionRoot !== path.dirname(path.dirname(ROOT)))
    throw Object.assign(new Error("計測は開発専用コピーで実行してください。常用側で node scripts/prepare-development.js を実行し、表示された作業場所を使ってください。"),{code:"development_workspace_required"});
  return m;
}

function printLaunchReadiness() {
  function inspect(api) { try { return api.launchReadinessFromSource(api.inspectRuntimeSource()); }
    catch { return api.launchReadinessFromSource(null); } }
  const own = inspect(prepare);
  console.log(`この作業場所のruntimeファイルのソース整合: ${own.status} (${own.reason})`);
  if (fs.existsSync(path.join(ROOT, DEVELOPMENT_MARKER))) {
    const m = requireDevelopmentWorkspace();
    const production = inspect(require(path.join(m.productionRoot,"scripts/prepare-runtime")));
    console.log(`常用側の次回起動ソース検査: ${production.status} (${production.reason})`);
  }
  console.log("本体の実起動・ログイン起動は別途確認が必要です。ファイル保持だけでは起動可能を意味しません。");
  return own;
}

function prepareDevelopment() {
  if (fs.existsSync(path.join(ROOT, DEVELOPMENT_MARKER))) throw new Error("開発コピーからの入れ子作成はできません。");
  const release = acquireSetupLock();
  let workspace = null;
  try {
    requireRuntime();
    const fingerprint = inputFingerprint();
    const parent = assertSafePath(path.join(ROOT,".development")); fs.mkdirSync(parent,{recursive:true});
    workspace = assertSafePath(path.join(parent,`workspace-${crypto.randomUUID()}`)); fs.mkdirSync(workspace);
    const marker = {schemaVersion:1,project:"mori-desk",kind:"development-workspace",projectRoot:workspace,
      productionRoot:ROOT,sourceFingerprint:fingerprint,ready:false,createdAt:new Date().toISOString()};
    const writeMarker = () => fs.writeFileSync(path.join(workspace,DEVELOPMENT_MARKER),JSON.stringify(marker,null,2)+"\n");
    writeMarker();
    function copy(relative) {
      const source = assertSafePath(path.join(ROOT,relative)), target = path.join(workspace,relative);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error("開発コピーへのリンクは許可されません。");
      if (stat.isDirectory()) {
        fs.mkdirSync(target,{recursive:true});
        for (const entry of fs.readdirSync(source)) copy(path.join(relative,entry));
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
      } else throw new Error("開発コピーへ通常ファイル以外は追加できません。");
    }
    for (const dir of ["scripts","bootstrap","patches","overlay","test"]) {
      if (fs.existsSync(path.join(ROOT,dir))) copy(dir);
    }
    for (const name of fs.readdirSync(ROOT)) {
      if (["package.json","upstream.lock.json",".nvmrc",".gitignore","AGENTS.md","README.md","LICENSE","NOTICE.md","MORI-NOTICE.md"].includes(name)
        || /^[a-z-]+\.bat$/.test(name)) copy(name);
    }
    // Copy design documents, not captures or user-provided evidence.
    if (fs.existsSync(path.join(ROOT,"docs"))) for (const name of fs.readdirSync(path.join(ROOT,"docs")))
      if (/\.md$/.test(name) && fs.lstatSync(path.join(ROOT,"docs",name)).isFile()) copy(path.join("docs",name));
    copy(".runtime");
    const runtimeOwner = requireOwner(RUNTIME,["runtime"]);
    fs.writeFileSync(path.join(workspace,".runtime/.mori-owned.json"),JSON.stringify({...runtimeOwner,projectRoot:workspace},null,2)+"\n");
    const cache = path.join(ROOT,".upstream/clawd-on-desk");
    if (fs.existsSync(cache)) {
      const cacheOwner = requireOwner(cache,["upstream-cache"]);
      copy(".upstream/clawd-on-desk");
      fs.writeFileSync(path.join(workspace,".upstream/clawd-on-desk/.mori-owned.json"),JSON.stringify({...cacheOwner,projectRoot:workspace},null,2)+"\n");
    }
    if (fingerprint !== inputFingerprint()) throw new Error("コピー中に常用側ソースが変更されました。");
    const devPrepare = require(path.join(workspace,"scripts/prepare-runtime"));
    if (devPrepare.inputFingerprint() !== fingerprint) throw new Error("開発コピーのソース指紋が一致しません。");
    devPrepare.requireRuntime(); requireRuntime();
    marker.ready = true; writeMarker();
    const next = path.join(parent,`latest-${crypto.randomUUID()}.json`);
    fs.writeFileSync(next,JSON.stringify(marker,null,2)+"\n",{flag:"wx"});fs.renameSync(next,path.join(parent,"latest.json"));
    console.log(`計測開発用の作業場所: ${workspace}`);
    console.log("以降の計測ソース編集・再構築・計測キットの作成は、この作業場所で行ってください。通常の Mori 起動はここでは拒否されます。");
    printLaunchReadiness();
    return marker;
  } catch (error) {
    if (workspace) console.error(`未完了の開発コピーを保持しました（既存のコピーは未変更）: ${workspace}`);
    throw error;
  } finally { release(); }
}

module.exports = { prepareDevelopment, requireDevelopmentWorkspace, printLaunchReadiness };
if (require.main === module) {
  try { if (process.argv.length !== 2) throw new Error("引数は指定できません。"); prepareDevelopment(); }
  catch (error) { console.error(`Development preparation failed: ${error.message}`);process.exitCode=1; }
}
