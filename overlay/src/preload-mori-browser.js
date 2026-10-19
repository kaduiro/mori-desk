"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mori", {
  status: () => ipcRenderer.invoke("mori:status"),
  pair: () => ipcRenderer.invoke("mori:pair"),
  copy: () => ipcRenderer.invoke("mori:copy-pair-code"),
  openExtension: () => ipcRenderer.invoke("mori:open-extension"),
  focus: (id, noticeSequence) => ipcRenderer.invoke("mori:focus", { id, noticeSequence }),
  ack: (id, noticeSequence) => ipcRenderer.invoke("mori:ack", { id, noticeSequence }),
  dismiss: id => ipcRenderer.invoke("mori:dismiss", { id }),
  revoke: clientId => ipcRenderer.invoke("mori:revoke", { clientId }),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on("mori:changed", listener);
    return () => ipcRenderer.removeListener("mori:changed", listener);
  },
});
