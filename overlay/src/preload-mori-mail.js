"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("moriMail", {
  state: () => ipcRenderer.invoke("mori-mail:state"),
  refresh: () => ipcRenderer.invoke("mori-mail:refresh"),
  more: () => ipcRenderer.invoke("mori-mail:more"),
  connect: () => ipcRenderer.invoke("mori-mail:connect"),
  disconnect: () => ipcRenderer.invoke("mori-mail:disconnect"),
  importConfig: () => ipcRenderer.invoke("mori-mail:import"),
  senders: senders => ipcRenderer.invoke("mori-mail:senders", { senders }),
  hide: id => ipcRenderer.invoke("mori-mail:hide", { id }),
  detail: id => ipcRenderer.invoke("mori-mail:detail", { id }),
  openLink: id => ipcRenderer.invoke("mori-mail:open-link", { id }),
  copyLink: id => ipcRenderer.invoke("mori-mail:copy-link", { id }),
  close: () => ipcRenderer.invoke("mori-mail:close"),
  setZoom: zoom => ipcRenderer.invoke("mori-mail:zoom", zoom),
  setSize: size => ipcRenderer.invoke("mori-mail:size", size),
  resizeGrip: phase => ipcRenderer.invoke("mori-mail:resize-grip", phase),
  setPinned: pinned => ipcRenderer.invoke("mori-mail:pin", pinned),
  setAutoOpen: enabled => ipcRenderer.invoke("mori-mail:auto-open", enabled),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on("mori-mail:changed", listener);
    return () => ipcRenderer.removeListener("mori-mail:changed", listener);
  },
});
