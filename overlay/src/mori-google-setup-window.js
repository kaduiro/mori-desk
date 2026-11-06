"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createGoogleSetupStore } = require("./mori-google-setup-store");

const ALLOWED_URLS = new Set([
  "https://console.cloud.google.com/",
  "https://developers.google.com/identity/protocols/oauth2/native-app",
  "https://developers.google.com/identity/protocols/oauth2/production-readiness/overview",
  "https://developers.google.com/workspace/gmail/api/reference/quota",
  "https://developers.google.com/workspace/calendar/api/guides/quota",
]);

function openFixedLink(url, shell) {
  if (!ALLOWED_URLS.has(url)) return false;
  try { void Promise.resolve(shell.openExternal(url)).catch(() => {}); }
  catch { return false; }
  return true;
}

function createGoogleSetupWindow({ BrowserWindow, shell, ipcMain, dataDir }) {
  let window = null;
  let store = null;
  try { store = createGoogleSetupStore(dataDir); } catch { /* Keep unreadable local state untouched. */ }
  const pagePath = path.join(__dirname, "mori-google-setup.html");
  const pageUrl = pathToFileURL(pagePath).href;
  function trusted(event) {
    return !!window && !window.isDestroyed() && event?.sender === window.webContents
      && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pageUrl;
  }
  ipcMain.handle("mori-google-setup:state", event => trusted(event)
    ? store ? { ok: true, ...store.snapshot() } : { ok: false, reason: "storage-error" }
    : { ok: false, reason: "untrusted-sender" });
  ipcMain.handle("mori-google-setup:save", (event, input) => {
    if (!trusted(event)) return { ok: false, reason: "untrusted-sender" };
    if (!store) return { ok: false, reason: "storage-error" };
    try { return { ok: true, ...store.save(input) }; }
    catch { return { ok: false, reason: "invalid-or-unwritable-state" }; }
  });
  function open() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return { ok: true }; }
    window = new BrowserWindow({ width: 760, height: 760, minWidth: 600, minHeight: 520,
      title: "Mori Desk · 個人 Google Cloud の準備", autoHideMenuBar: true,
      backgroundColor: "#20252b", webPreferences: {
        preload: path.join(__dirname, "preload-mori-google-setup.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      } });
    window.webContents.setWindowOpenHandler(({ url }) => {
      openFixedLink(url, shell);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.loadFile(pagePath);
    window.on("closed", () => { window = null; });
    return { ok: true };
  }
  function dispose() {
    ipcMain.removeHandler("mori-google-setup:state");
    ipcMain.removeHandler("mori-google-setup:save");
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }
  return { open, dispose };
}

module.exports = { ALLOWED_URLS, openFixedLink, createGoogleSetupWindow };
