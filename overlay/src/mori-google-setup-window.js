"use strict";

const path = require("node:path");

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

function createGoogleSetupWindow({ BrowserWindow, shell }) {
  let window = null;
  function open() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return { ok: true }; }
    window = new BrowserWindow({ width: 760, height: 760, minWidth: 600, minHeight: 520,
      title: "Mori Desk · 個人 Google Cloud の準備", autoHideMenuBar: true,
      backgroundColor: "#20252b", webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      } });
    window.webContents.setWindowOpenHandler(({ url }) => {
      openFixedLink(url, shell);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", event => event.preventDefault());
    window.loadFile(path.join(__dirname, "mori-google-setup.html"));
    window.on("closed", () => { window = null; });
    return { ok: true };
  }
  function dispose() {
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }
  return { open, dispose };
}

module.exports = { ALLOWED_URLS, openFixedLink, createGoogleSetupWindow };
