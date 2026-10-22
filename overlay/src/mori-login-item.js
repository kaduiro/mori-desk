"use strict";

// OS registration policy. Only the settings-controller action calls setEnabled;
// status reconciliation is read-only and never revives an OS-disabled entry.
const fs = require("node:fs");
const { createRegistrationNameProbe } = require("./mori-login-registry");
const PRODUCT_ID = "com.kaduiro.moridesk";
const status = (state, enabled, reason) => Object.freeze({ state, enabled, reason });
function unquote(value) {
  return typeof value === "string" && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
function samePhysicalPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try { return fs.realpathSync.native(unquote(left)) === fs.realpathSync.native(unquote(right)); }
  catch { return false; }
}
function createLoginItemController({ app, execPath, appPath, bootstrapPath, platform = process.platform,
  samePath = samePhysicalPath, probeName = createRegistrationNameProbe({ platform }) }) {
  const source = !app.isPackaged;
  // Electron 41 quotes each argument itself. Its launchItems.args omits
  // switches, so it cannot prove the login flag (or absence of foreign flags).
  const desiredArgs = source ? [bootstrapPath, "--mori-startup=login"] : ["--mori-startup=login"];
  const legacyArgs = source ? [appPath] : [];
  // Electron 41 parses the lookup executable as a command line. Quoting only
  // this field fixes spaces; FormatCommandLineString strips its outer quotes
  // before making the exact fixed-AppUserModelID Run-value comparison below.
  const queryPath = `"${unquote(execPath)}"`;
  const query = platform === "win32" ? { path: queryPath, args: desiredArgs } : {};
  function inspect() {
    let raw;
    try { raw = app.getLoginItemSettings(query); }
    catch { return { public: status("unavailable", null, "os_read_failed"), owned: false }; }
    if (platform !== "win32") {
      if (source) return { public: status("unavailable", null, "source_platform_unverified"), owned: false };
      if (raw.status === "requires-approval") return { public: status("os_disabled", false, "os_approval_required"), owned: true };
      return { public: status(raw.openAtLogin ? "enabled" : "disabled", !!raw.openAtLogin, "current"), owned: true };
    }
    let presence;
    try { presence = probeName(); } catch { presence = null; }
    if (!presence || typeof presence.user !== "boolean" || typeof presence.machine !== "boolean")
      return { public: status("unavailable", null, "registration_probe_failed"), owned: false };
    if (presence.machine) return { public: status("unconfirmed", null, "registration_ambiguous"), owned: false };
    if (!Array.isArray(raw.launchItems)) return { public: status("unconfirmed", null, "os_result_incomplete"), owned: false };
    const named = raw.launchItems.filter(item => item && item.name === PRODUCT_ID);
    if (named.length > 1 || named.some(item => item.scope !== "user"))
      return { public: status("unconfirmed", null, "registration_ambiguous"), owned: false };
    if (!named.length) {
      if (presence.user) return { public: status("unconfirmed", null, "foreign_registration"), owned: false };
      if (raw.openAtLogin === true) return { public: status("unconfirmed", null, "registration_ambiguous"), owned: false };
      return { public: status("disabled", false, "not_registered"), owned: true };
    }
    if (!presence.user) return { public: status("unconfirmed", null, "registration_ambiguous"), owned: false };
    const entry = named[0];
    if (!samePath(entry.path, execPath)) return { public: status("unconfirmed", null, "foreign_registration"), owned: false };
    // openAtLogin compares the *complete* command at the app's fixed product
    // ID, independently of launchItems' filtered argument list. main sets the
    // same PRODUCT_ID as AppUserModelID before any controller call.
    const current = raw.openAtLogin === true;
    let legacy = false;
    if (!current) {
      try { legacy = app.getLoginItemSettings({ path: queryPath, args: legacyArgs }).openAtLogin === true; }
      catch { return { public: status("unavailable", null, "os_read_failed"), owned: false }; }
    }
    if (!current && !legacy)
      return { public: status("unconfirmed", null, "foreign_registration"), owned: false };
    if (entry.enabled === false) return { public: status("os_disabled", false, "os_disabled"), owned: true };
    if (entry.enabled !== true) return { public: status("unconfirmed", null, "os_result_incomplete"), owned: false };
    if (legacy) return { public: status("legacy", true, "migration_required"), owned: true };
    return { public: status("enabled", true, "current"), owned: true };
  }
  return {
    getStatus() { return inspect().public; },
    setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("login_invalid_value");
      const before = inspect();
      if (!before.owned) throw new Error(`login_${before.public.reason}`);
      const settings = platform === "win32"
        ? { openAtLogin: enabled, path: execPath, args: desiredArgs, name: PRODUCT_ID, enabled }
        : { openAtLogin: enabled };
      app.setLoginItemSettings(settings);
      const after = inspect().public;
      if ((enabled && after.state !== "enabled") || (!enabled && after.state !== "disabled"))
        throw new Error(`login_readback_failed:${after.reason}`);
      return after;
    },
  };
}
module.exports = { createLoginItemController, samePhysicalPath, PRODUCT_ID };
