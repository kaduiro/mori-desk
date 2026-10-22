"use strict";

// Synthetic IPC for the opt-in renderer smoke only. Production preloads are
// unchanged; no real pairing, browser tab, clipboard, or focus API is invoked.
const { contextBridge, ipcRenderer } = require("electron");
const invoke = (operation, ...args) => ipcRenderer.invoke("mori-renderer-smoke", operation, ...args);
contextBridge.exposeInMainWorld("mori", {
  status: () => invoke("status"),
  onChange: callback => ipcRenderer.on("mori-smoke-change", () => callback()),
  setLabel: (id, label) => invoke("setLabel", id, label),
  ack: (id, sequence) => invoke("ack", id, sequence),
  dismiss: id => invoke("dismiss", id),
  focus: (id, sequence) => invoke("focus", id, sequence),
  pair: () => invoke("unused"), copy: () => invoke("unused"), openExtension: () => invoke("unused"),
});
contextBridge.exposeInMainWorld("sessionHudAPI", {
  onLangChange: () => {},
  onSessionSnapshot: callback => ipcRenderer.on("mori-smoke-snapshot", (_event, value) => callback(value)),
  getI18n: async () => ({ lang: "ja", translations: {
    sessionJustNow: "たった今", sessionHudElapsedSec: "{n} 秒前", sessionHudElapsedMinSec: "{m} 分 {s} 秒前",
    sessionMinAgo: "{n} 分前", sessionHrAgo: "{n} 時間前", sessionHudOtherActive: "ほか {n} 件",
    sessionHudPinTooltip: "固定する", sessionHudUnpinTooltip: "固定を解除",
  } }),
  openBrowserPanel: id => invoke("select", id),
  focusBrowser: (id, sequence) => invoke("focus", id, sequence),
  setPinned: () => invoke("unused"), openDashboard: () => invoke("unused"),
});
