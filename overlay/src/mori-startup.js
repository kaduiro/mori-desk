"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { failure, parseStartupArgs, validBuildInfo, createReporter, reasonOf } = require("./mori-startup-contract");

function initializeStartup({ app, processObject = process }) {
  const startup = parseStartupArgs(processObject.argv.slice(app.isPackaged ? 1 : 2));
  const appPath = app.getAppPath();
  const pkg = JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8"));
  const buildInfo = JSON.parse(fs.readFileSync(path.join(appPath, "src/mori-build-info.json"), "utf8"));
  // electron-builder removes the development-only build field from packaged
  // package.json. Packaged startup relies on its embedded product/build data;
  // source startup additionally verifies the full distribution configuration.
  if (pkg.name !== "mori-desk" || !validBuildInfo(buildInfo, pkg.version)
      || (!app.isPackaged && (pkg.build?.appId !== "com.kaduiro.moridesk" || pkg.build?.publish !== null)))
    throw failure("build_invalid");
  let recheck = () => {};
  if (!app.isPackaged) {
    if (path.basename(appPath) !== ".runtime") throw failure("runtime_unavailable");
    const guard = require(path.join(appPath, "..", "scripts/startup-guard"));
    const owner = guard.readStartupOwner(processObject.env, processObject.ppid);
    recheck = () => {
      const verified = guard.verifySourceStartup({ appPath, execPath: processObject.execPath, owner });
      if (verified.buildInfo.buildId !== buildInfo.buildId) throw failure("build_invalid");
    };
    recheck();
    // The closure retains the handoff for the final recheck. Do not propagate
    // a completed bootstrap parent's PID/token to unrelated future children.
    delete processObject.env.MORI_STARTUP_LOCK_TOKEN;
    delete processObject.env.MORI_STARTUP_PARENT_PID;
  }
  const reporter = createReporter(processObject, buildInfo);
  return Object.freeze({ ...startup, buildInfo: Object.freeze(buildInfo), recheck,
    hasParent: reporter.hasParent, report: reporter.report });
}

async function reportStartupFailure({ app, dialog, error, startup, processObject = process }) {
  const reporter = startup || createReporter(processObject, null);
  await reporter.report("blocked", reasonOf(error));
  if (!reporter.hasParent) {
    await app.whenReady();
    dialog.showErrorBox("Mori Desk", `本体を起動できません（${reasonOf(error)}）。\n` +
      "通常のセットアップと起動手順を確認してください。保存済みデータは初期化していません。");
  }
  app.exit(1);
}

function bridgeBuildInfo(startup) {
  return { desktopVersion: startup.buildInfo.version, buildId: startup.buildInfo.buildId,
    observerContract: startup.buildInfo.observerContract };
}
module.exports = { initializeStartup, reportStartupFailure, bridgeBuildInfo };
