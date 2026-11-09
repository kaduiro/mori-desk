"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mori", {
  status: () => ipcRenderer.invoke("mori:status"),
  repairLogin: () => ipcRenderer.invoke("mori:repair-login"),
  setLoginStartup: value => ipcRenderer.invoke("mori:set-login-startup", value),
  setHudStartup: (kind, enabled) => ipcRenderer.invoke("mori:set-hud-startup", { kind, enabled }),
  openCalendar: () => ipcRenderer.invoke("mori:open-calendar"),
  openGoogleSetup: () => ipcRenderer.invoke("mori:open-google-setup"),
  openAgentSettings: () => ipcRenderer.invoke("mori:open-agent-settings"),
  installCliHook: agentId => ipcRenderer.invoke("mori:install-cli-hook", agentId),
  pair: () => ipcRenderer.invoke("mori:pair"),
  copy: () => ipcRenderer.invoke("mori:copy-pair-code"),
  openExtension: () => ipcRenderer.invoke("mori:open-extension"),
  copyChromeSetup: () => ipcRenderer.invoke("mori:copy-chrome-setup"),
  restartCli: () => ipcRenderer.invoke("mori:restart-cli"),
  openMail: () => ipcRenderer.invoke("mori:open-mail"),
  focus: (id, noticeSequence) => ipcRenderer.invoke("mori:focus", { id, noticeSequence }),
  ack: (id, noticeSequence) => ipcRenderer.invoke("mori:ack", { id, noticeSequence }),
  acknowledgeGap: (id, eventId) => ipcRenderer.invoke('mori:ack-gap', { id, eventId }),
  dismiss: id => ipcRenderer.invoke("mori:dismiss", { id }),
  setLabel: (id, label) => ipcRenderer.invoke("mori:set-label", { id, label }),
  revoke: clientId => ipcRenderer.invoke("mori:revoke", { clientId }),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on("mori:changed", listener);
    return () => ipcRenderer.removeListener("mori:changed", listener);
  },
});
