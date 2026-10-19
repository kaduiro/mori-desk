"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getBrowserStatus } = require("./mori-browser-status");

module.exports = function createBrowserWindowRuntime({ BrowserWindow, ipcMain, clipboard,
  shell, getBridge, getPort, getHudWindow, cliEnabled, getStartupError = () => "",
  getListenerStatus = () => null, getLoginStatus = () => null, setLoginStartup = null,
  repairLoginItem = null, openAgentSettings = null, installCliHook = null, getBuildInfo = () => null,
  getPetBounds = () => null, getCalendarSuppressed = () => false, getDoNotDisturb = () => false,
  calendarDependencies = null }) {
  let window = null;
  let pairing = null;
  let selectedSessionId = null;
  let selectionRevision = 0;
  const page = pathToFileURL(path.join(__dirname, "mori-browser.html")).toString();
  const hudPage = pathToFileURL(path.join(__dirname, "session-hud.html")).toString();
  const handlers = [];
  let calendarRuntime = null;
  let calendarWindow = null;
  let calendarSetupWindow = null;
  let mailRuntime = null;
  let mailWindow = null;
  let googleSetupWindow = null;
  let reminderService = null;
  function ensureReminderService(electron) {
    if (reminderService) return reminderService;
    try {
      const { createReminderService } = require("./mori-reminder-service");
      reminderService = createReminderService({
        dataDir: path.join(electron.app.getPath("userData"), "reminders"),
        Notification: electron.Notification,
        suppressed: getDoNotDisturb,
        openMail: () => { ensureMail(); mailRuntime.start(); mailWindow.open(); },
        openCalendar: () => { ensureCalendar(); calendarRuntime.start(); calendarWindow.open(); },
      });
      reminderService.start();
    } catch { /* Unreadable optional notification state must not stop the HUDs. */ }
    return reminderService;
  }
  function openGoogleSetup() {
    if (!googleSetupWindow) {
      const { createGoogleSetupWindow } = require("./mori-google-setup-window");
      const electron = calendarDependencies || require("electron");
      googleSetupWindow = createGoogleSetupWindow({ BrowserWindow, shell, ipcMain, clipboard,
        dataDir: path.join(electron.app.getPath("userData"), "google-setup") });
    }
    return googleSetupWindow.open();
  }
  function ensureCalendar() {
    if (calendarRuntime) return;
    const calendarElectron = calendarDependencies || require("electron");
    const reminders = ensureReminderService(calendarElectron);
    const { createCalendarRuntime } = require("./mori-calendar-runtime");
    const { createCalendarWindow } = require("./mori-calendar-window");
    const { createCalendarSetupWindow } = require("./mori-calendar-setup-window");
    const calendarDir = path.join(calendarElectron.app.getPath("userData"), "calendar");
    const managedClientFile = calendarElectron.app.isPackaged && process.resourcesPath
      ? path.join(process.resourcesPath, "mori-calendar-client.json") : null;
    calendarRuntime = createCalendarRuntime({
      dataDir: calendarDir,
      safeStorage: calendarElectron.safeStorage, shell, managedClientFile,
      onChange: () => { calendarWindow?.notify(); calendarSetupWindow?.notify();
        reminders?.onCalendar(calendarRuntime.snapshot()); },
    });
    calendarWindow = createCalendarWindow({
      BrowserWindow, ipcMain, shell, screen: calendarElectron.screen,
      runtime: calendarRuntime, getPetBounds, getOtherBounds: () => mailWindow?.getBounds(),
      getSuppressed: getCalendarSuppressed,
      dataDir: calendarDir, openSetup: () => calendarSetupWindow.open(), reminders,
    });
    calendarSetupWindow = createCalendarSetupWindow({ BrowserWindow, ipcMain,
      dialog: calendarElectron.dialog, runtime: calendarRuntime, dataDir: calendarDir,
      openCalendar: () => calendarWindow.open(), openBrowserPanel: () => open(),
      openGoogleSetup });
  }
  function ensureMail() {
    if (mailRuntime) return;
    const electron = calendarDependencies || require("electron");
    const reminders = ensureReminderService(electron);
    const { createMailRuntime } = require("./mori-mail-runtime");
    const { createMailWindow } = require("./mori-mail-window");
    const mailDir = path.join(electron.app.getPath("userData"), "mail");
    mailRuntime = createMailRuntime({ dataDir: mailDir,
      safeStorage: electron.safeStorage, shell, onChange: () => {
        mailWindow?.notify(); reminders?.onMail(mailRuntime.snapshot()); } });
    mailWindow = createMailWindow({ BrowserWindow, ipcMain, dialog: electron.dialog,
      clipboard, shell, screen: electron.screen, runtime: mailRuntime, dataDir: mailDir,
      getPetBounds, getOtherBounds: () => calendarWindow?.getBounds(),
      getSuppressed: getCalendarSuppressed, openGoogleSetup, reminders });
  }

  function trusted(event, allowHud = false) {
    const frame = event?.senderFrame;
    if (!frame || frame !== event.sender?.mainFrame) return false;
    if (window && !window.isDestroyed() && event.sender === window.webContents && frame.url === page) return true;
    const hud = allowHud && getHudWindow?.();
    return !!hud && !hud.isDestroyed() && event.sender === hud.webContents && frame.url === hudPage;
  }

  function handle(channel, fn, allowHud = false) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!trusted(event, allowHud)) return { ok: false, reason: "untrusted-sender" };
      try { return await fn(payload); }
      catch (error) { return { ok: false, reason: error?.code || "operation-failed", message: String(error?.message || error).slice(0,300) }; }
    });
    handlers.push(channel);
  }

  function state() {
    const bridge = getBridge();
    const bridgeStatus = bridge?.getStatus() || null;
    const listener = getListenerStatus();
    const port = listener ? (listener.state === "listening" ? listener.port : null) : getPort();
    const error = getStartupError();
    return { ok: !!bridge, port, cliEnabled, bridge: bridgeStatus,
      connection: getBrowserStatus({ bridge: bridgeStatus, port, error, listener,
        login: getLoginStatus(), buildInfo: getBuildInfo() }),
      sessions: bridge?.getSnapshot() || [], error,
      selectedSessionId, selectionRevision,
      hudStartup: { calendar: calendarWindow?.autoOpenEnabled() ?? null,
        mail: mailWindow?.autoOpenEnabled() ?? null },
      pairingExpiresAt: pairing?.expiresAt || null };
  }

  handle("mori:status", state);
  handle("mori:repair-login", () => {
    if (typeof repairLoginItem !== "function" || getLoginStatus()?.reason !== "source_registration")
      return { ok: false, reason: "repair_not_available" };
    return repairLoginItem();
  });
  handle("mori:set-login-startup", value => {
    if (typeof value !== "boolean" || typeof setLoginStartup !== "function")
      return { ok: false, reason: "invalid-or-unavailable" };
    return setLoginStartup(value);
  });
  handle("mori:set-hud-startup", value => {
    if (!value || !["calendar", "mail"].includes(value.kind) || typeof value.enabled !== "boolean")
      return { ok: false, reason: "invalid-payload" };
    if (value.kind === "calendar") { ensureCalendar(); return calendarWindow.setAutoOpen(value.enabled); }
    ensureMail(); return mailWindow.setAutoOpen(value.enabled);
  });
  handle("mori:open-calendar", () => {
    ensureCalendar(); calendarRuntime.start(); return calendarWindow.open();
  });
  handle("mori:open-google-setup", () => openGoogleSetup());
  handle("mori:open-agent-settings", () => {
    if (!cliEnabled || typeof openAgentSettings !== "function") return { ok: false, reason: "cli-disabled" };
    openAgentSettings(); return { ok: true };
  });
  handle("mori:install-cli-hook", async value => {
    if (!cliEnabled || typeof installCliHook !== "function") return { ok: false, reason: "cli-disabled" };
    if (!["codex", "claude-code"].includes(value)) return { ok: false, reason: "invalid-agent" };
    const result = await installCliHook(value);
    return { ok: result?.status === "ok", reason: result?.status === "ok" ? undefined : "install-failed",
      message: String(result?.message || "").slice(0, 300) };
  });
  handle("mori:pair", () => {
    const bridge = getBridge();
    const listener = getListenerStatus();
    const port = listener ? (listener.state === "listening" ? listener.port : null) : getPort();
    if (!bridge || !port) return { ok: false, reason: "server-not-ready", message: getStartupError() || "接続サーバーの準備ができていません。" };
    pairing = bridge.beginPairing(port);
    return { ok: true, ...pairing };
  });
  handle("mori:copy-pair-code", () => {
    if (!pairing || pairing.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
    clipboard.writeText(pairing.code);
    return { ok: true };
  });
  handle("mori:focus", payload => {
    if (typeof payload?.id !== "string" || payload.id.length > 512
      || (payload.noticeSequence != null && !Number.isSafeInteger(payload.noticeSequence))) return { ok: false, reason: "invalid-payload" };
    return getBridge()?.focus(payload.id, payload.noticeSequence) || { ok: false, reason: "not-connected" };
  }, true);
  handle("mori:ack", payload => {
    if (typeof payload?.id !== "string" || !Number.isSafeInteger(payload.noticeSequence)) return { ok: false, reason: "invalid-payload" };
    return getBridge()?.ack(payload.id, payload.noticeSequence) || { ok: false, reason: "not-ready" };
  }, true);
  handle("mori:dismiss", payload => {
    if (typeof payload?.id !== "string" || payload.id.length > 512) return { ok: false, reason: "invalid-payload" };
    return getBridge()?.dismiss(payload.id) || { ok: false, reason: "not-ready" };
  });
  handle('mori:ack-gap', payload => {
    if (typeof payload?.id !== 'string' || payload.id.length > 512
      || typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.eventId)) return { ok: false, reason: 'invalid-payload' };
    return getBridge()?.acknowledgeGap(payload.id, payload.eventId) || { ok: false, reason: 'not-ready' };
  });
  handle("mori:set-label", payload => {
    if (typeof payload?.id !== "string" || payload.id.length > 512
      || typeof payload.label !== "string" || payload.label.length > 80) return { ok: false, reason: "invalid-payload" };
    return getBridge()?.setLabel(payload.id, payload.label) || { ok: false, reason: "not-ready" };
  });
  handle("mori:revoke", payload => {
    if (typeof payload?.clientId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.clientId)) return { ok: false, reason: "invalid-client" };
    return getBridge()?.revoke(payload.clientId) || { ok: false, reason: "not-ready" };
  });
  handle("mori:open-extension", async () => {
    const extensionDir = path.join(__dirname, "..", "extensions", "browser-bridge")
      .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const reason = await shell.openPath(extensionDir);
    return { ok: !reason, message: reason || "" };
  });
  handle("mori:copy-chrome-setup", () => {
    clipboard.writeText("chrome://extensions");
    return { ok: true };
  });
  handle("mori:restart-cli", () => {
    if (cliEnabled) return { ok: false, reason: "already-enabled" };
    const electron = calendarDependencies || require("electron");
    if (!electron.app?.relaunch || !electron.app?.quit) return { ok: false, reason: "unavailable" };
    const args = [...process.argv.slice(1).filter(arg => arg !== "--enable-cli"), "--enable-cli"];
    electron.app.relaunch({ args });
    setImmediate(() => electron.app.quit());
    return { ok: true };
  });
  handle("mori:open-panel", payload => {
    if (payload !== undefined && (typeof payload?.id !== "string" || payload.id.length > 512)) return { ok: false, reason: "invalid-payload" };
    return open(payload);
  }, true);
  handle("mori:open-mail", () => {
    ensureMail();
    mailRuntime.start();
    return mailWindow.open();
  });

  function open(options) {
    if (typeof options?.id === "string") {
      if (!getBridge()?.getSnapshot().some(row => row.id === options.id)) return { ok: false, reason: "session_missing" };
      selectedSessionId = options.id;
      selectionRevision += 1;
    }
    if (window && !window.isDestroyed()) { window.show(); window.focus(); notify(); return { ok: true }; }
    window = new BrowserWindow({ width: 790, height: 690, minWidth: 620, minHeight: 480,
      title: "Mori Desk · ブラウザ連携", autoHideMenuBar: true, backgroundColor: "#18181b",
      webPreferences: { preload: path.join(__dirname, "preload-mori-browser.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.loadFile(path.join(__dirname, "mori-browser.html"));
    window.on("closed", () => { window = null; pairing = null; selectedSessionId = null; });
    return { ok: true };
  }

  function notify() {
    if (window && !window.isDestroyed()) window.webContents.send("mori:changed");
  }

  function dispose() {
    handlers.forEach(channel => ipcMain.removeHandler(channel));
    calendarWindow?.dispose();
    calendarSetupWindow?.dispose();
    calendarRuntime?.dispose();
    mailWindow?.dispose();
    mailRuntime?.dispose();
    reminderService?.dispose();
    googleSetupWindow?.dispose();
    if (window && !window.isDestroyed()) window.destroy();
    window = null; pairing = null;
  }
  function startCalendar() {
    ensureCalendar();
    if (calendarWindow.autoOpenEnabled() || reminderService?.enabled("calendar")) {
      if (calendarWindow.autoOpenEnabled()) calendarWindow.open({ automatic: true });
      calendarRuntime.start();
    }
    startMail();
    notify();
  }
  function startMail() {
    ensureMail();
    if (mailWindow.autoOpenEnabled() || reminderService?.enabled("mail")) {
      if (mailWindow.autoOpenEnabled()) mailWindow.open({ automatic: true });
      mailRuntime.start();
    }
  }
  return { open, notify, dispose, startCalendar, startMail, openMail: () => {
    ensureMail();
    mailRuntime.start();
    return mailWindow.open();
  }, openCalendar: () => {
    ensureCalendar();
    calendarRuntime.start();
    return calendarWindow.open();
  } };
};
