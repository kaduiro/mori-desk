"use strict";

// Mori Desk is a source derivative. Keep product data and opt-in CLI ownership
// separate from the upstream application. Never migrate shared CLI files here.
const path = require("node:path");
const serverConfig = require("../hooks/server-config");

const PRODUCT_ID = "com.kaduiro.moridesk";
const EXTENSION_ID = "obooegdoanifidoffaodpobadpeiilcl";
const cliEnabled = process.argv.includes("--enable-cli");

function configureApp(app) {
  app.setName("Mori Desk");
  const testData = !app.isPackaged && process.env.MORI_DESK_TEST_DATA_DIR;
  app.setPath("userData", testData && path.isAbsolute(testData) ? testData : path.join(app.getPath("appData"), "MoriDesk"));
}

function requireCliMode(options = {}) {
  const enabled = options.cliEnabled === undefined ? cliEnabled : options.cliEnabled;
  if (!enabled) {
    const error = new Error("CLI 連携は無効です。元の Clawd を終了して start-cli-windows.bat から起動してください。");
    error.code = "MORI_CLI_DISABLED";
    throw error;
  }
  assertCliRuntimeAvailable(options);
}

function assertCliRuntimeAvailable(options = {}) {
  const enabled = options.cliEnabled === undefined ? cliEnabled : options.cliEnabled;
  if (!enabled) return;
  const readIdentity = options.readRuntimeIdentity || (() => serverConfig.readRuntimeIdentity());
  const probeProcess = options.probeProcess || ((pid) => process.kill(pid, 0));
  const ownPid = options.ownPid === undefined ? process.pid : options.ownPid;
  const identity = readIdentity();
  if (identity && identity.ok && identity.ownerPid && identity.ownerPid !== ownPid) {
    // Runtime parsing deliberately does not prove liveness. A crash can leave
    // a valid runtime.json behind. Only ESRCH proves that owner is gone;
    // permission failures and all other uncertain results must keep the gate shut.
    try { probeProcess(identity.ownerPid); }
    catch (error) { if (error && error.code === "ESRCH") return; }
    const error = new Error("別の Clawd / Mori Desk が CLI 連携を使用しているか、終了を確認できません。先にそのアプリを終了してください。");
    error.code = "MORI_CLI_RUNTIME_BUSY";
    throw error;
  }
}

function privateRuntimeOptions(userData, overrides = {}) {
  const enabled = overrides.cliEnabled === undefined ? cliEnabled : overrides.cliEnabled;
  if (enabled) {
    return {
      writeRuntimeConfig: (port, extra) => {
        // Check immediately before each publish/Doctor repair, not only once
        // before app.whenReady(). A different app can become the owner later.
        assertCliRuntimeAvailable({ ...overrides, cliEnabled: true });
        return (overrides.writeRuntimeConfig || serverConfig.writeRuntimeConfig)(port, extra);
      },
    };
  }
  const runtimeConfigPath = path.join(userData, "browser-runtime.json");
  const options = { runtimeConfigPath };
  return {
    runtimeConfigPath,
    readRuntimeIdentity: () => serverConfig.readRuntimeIdentity(options),
    readRuntimePort: () => serverConfig.readRuntimePort(options),
    writeRuntimeConfig: (port, extra) => serverConfig.writeRuntimeConfig(port, { ...extra, ...options }),
    clearRuntimeConfig: () => serverConfig.clearRuntimeConfig(runtimeConfigPath),
  };
}

module.exports = { PRODUCT_ID, EXTENSION_ID, cliEnabled, configureApp, requireCliMode,
  assertCliRuntimeAvailable, privateRuntimeOptions };
