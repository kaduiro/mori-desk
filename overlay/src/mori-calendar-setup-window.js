"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installClientConfig } = require("./mori-calendar-client-config");

function createCalendarSetupWindow({ BrowserWindow, ipcMain, dialog, runtime, dataDir,
  openCalendar, openBrowserPanel = () => ({ ok: false, reason: "unavailable" }) }) {
  let window = null;
  const pagePath = path.join(__dirname, "mori-calendar-setup.html");
  const pageUrl = pathToFileURL(pagePath).href;
  const channels = [];
  function trusted(event) {
    return !!window && !window.isDestroyed() && event?.sender === window.webContents
      && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pageUrl;
  }
  function handle(channel, action) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!trusted(event)) return { ok: false, reason: "untrusted-sender" };
      try { return await action(payload); }
      catch { return { ok: false, reason: "operation-failed" }; }
    });
    channels.push(channel);
  }
  handle("mori-calendar-setup:state", () => ({ ok: true, ...runtime.diagnostics() }));
  handle("mori-calendar-setup:import", async () => {
    if (!runtime.canImportClient()) return { ok: false, reason: "disconnect-first" };
    const selected = await dialog.showOpenDialog(window, {
      title: "Google デスクトップ OAuth 設定を選択",
      properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return { ok: false, reason: "cancelled" };
    try { installClientConfig(selected.filePaths[0], dataDir); }
    catch (error) { return { ok: false, reason: error.message || "invalid-config-file" }; }
    const loaded = runtime.reloadClient();
    return loaded.status === "storage-error" ? { ok: false, reason: loaded.reason }
      : { ok: true, ...runtime.diagnostics() };
  });
  handle("mori-calendar-setup:connect", async () => {
    await runtime.connect();
    return { ok: true, ...runtime.diagnostics() };
  });
  handle("mori-calendar-setup:calendars", async () => {
    await runtime.loadCalendars(true);
    return { ok: true, ...runtime.diagnostics() };
  });
  handle("mori-calendar-setup:select", async payload => {
    const result = await runtime.selectCalendars(payload?.ids);
    return result.ok ? { ok: true, ...runtime.diagnostics() } : result;
  });
  handle("mori-calendar-setup:disconnect", () => {
    runtime.disconnect();
    return { ok: true, ...runtime.diagnostics() };
  });
  handle("mori-calendar-setup:use-managed", () => runtime.switchToManaged());
  handle("mori-calendar-setup:open-calendar", () => openCalendar());
  handle("mori-calendar-setup:open-browser", () => openBrowserPanel());
  function open() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return { ok: true }; }
    window = new BrowserWindow({ width: 540, height: 650, minWidth: 480, minHeight: 530,
      title: "Mori Desk · 今日の予定の設定", autoHideMenuBar: true,
      backgroundColor: "#222228", webPreferences: {
        preload: path.join(__dirname, "preload-mori-calendar-setup.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.loadFile(pagePath);
    window.on("closed", () => { window = null; });
    return { ok: true };
  }
  function notify() {
    if (window && !window.isDestroyed()) window.webContents.send("mori-calendar-setup:changed");
  }
  function dispose() {
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }
  return { open, notify, dispose };
}

module.exports = { createCalendarSetupWindow };
