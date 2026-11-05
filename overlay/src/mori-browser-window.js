"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getBrowserStatus } = require("./mori-browser-status");

module.exports = function createBrowserWindowRuntime({ BrowserWindow, ipcMain, clipboard,
  shell, getBridge, getPort, getHudWindow, cliEnabled, getStartupError = () => "",
  getListenerStatus = () => null, getLoginStatus = () => null, getBuildInfo = () => null,
  getPetBounds = () => null, getCalendarSuppressed = () => false,
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
  function ensureCalendar() {
    if (calendarRuntime) return;
    const calendarElectron = calendarDependencies || require("electron");
    const { createCalendarRuntime } = require("./mori-calendar-runtime");
    const { createCalendarWindow } = require("./mori-calendar-window");
    const { createCalendarSetupWindow } = require("./mori-calendar-setup-window");
    const calendarDir = path.join(calendarElectron.app.getPath("userData"), "calendar");
    const managedClientFile = calendarElectron.app.isPackaged && process.resourcesPath
      ? path.join(process.resourcesPath, "mori-calendar-client.json") : null;
    calendarRuntime = createCalendarRuntime({
      dataDir: calendarDir,
      safeStorage: calendarElectron.safeStorage, shell, managedClientFile,
      onChange: () => { calendarWindow?.notify(); calendarSetupWindow?.notify(); },
    });
    calendarWindow = createCalendarWindow({
      BrowserWindow, ipcMain, shell, screen: calendarElectron.screen,
      runtime: calendarRuntime, getPetBounds, getOtherBounds: () => mailWindow?.getBounds(),
      getSuppressed: getCalendarSuppressed,
      dataDir: calendarDir, openSetup: () => calendarSetupWindow.open(),
    });
    calendarSetupWindow = createCalendarSetupWindow({ BrowserWindow, ipcMain,
      dialog: calendarElectron.dialog, runtime: calendarRuntime, dataDir: calendarDir,
      openCalendar: () => calendarWindow.open(), openBrowserPanel: () => open() });
  }
  function ensureMail() {
    if (mailRuntime) return;
    const electron = calendarDependencies || require("electron");
    const { createMailRuntime } = require("./mori-mail-runtime");
    const { createMailWindow } = require("./mori-mail-window");
    const mailDir = path.join(electron.app.getPath("userData"), "mail");
    mailRuntime = createMailRuntime({ dataDir: mailDir,
      safeStorage: electron.safeStorage, shell, onChange: () => mailWindow?.notify() });
    mailWindow = createMailWindow({ BrowserWindow, ipcMain, dialog: electron.dialog,
      clipboard, shell, screen: electron.screen, runtime: mailRuntime, dataDir: mailDir,
      getPetBounds, getOtherBounds: () => calendarWindow?.getBounds(),
      getSuppressed: getCalendarSuppressed });
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
      pairingExpiresAt: pairing?.expiresAt || null };
  }

  handle("mori:status", state);
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
      title: "Mori Desk · ブラウザ連携", autoHideMenuBar: true, backgroundColor: "#f5f6ee",
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
    if (window && !window.isDestroyed()) window.destroy();
    window = null; pairing = null;
  }
  function startCalendar() {
    ensureCalendar();
    if (calendarWindow.autoOpenEnabled()) {
      calendarWindow.open({ automatic: true });
      calendarRuntime.start();
    }
    startMail();
  }
  function startMail() {
    ensureMail();
    if (!mailWindow.autoOpenEnabled()) return;
    mailWindow.open({ automatic: true });
    mailRuntime.start();
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
