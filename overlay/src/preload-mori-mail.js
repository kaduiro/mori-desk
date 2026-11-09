"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("moriMail", {
  state: () => ipcRenderer.invoke("mori-mail:state"),
  refresh: () => ipcRenderer.invoke("mori-mail:refresh"),
  more: () => ipcRenderer.invoke("mori-mail:more"),
  connect: () => ipcRenderer.invoke("mori-mail:connect"),
  disconnect: () => ipcRenderer.invoke("mori-mail:disconnect"),
  importConfig: () => ipcRenderer.invoke("mori-mail:import"),
  openGoogleSetup: () => ipcRenderer.invoke("mori-mail:open-google-setup"),
  senders: senders => ipcRenderer.invoke("mori-mail:senders", { senders }),
  hide: id => ipcRenderer.invoke("mori-mail:hide", { id }),
  detail: id => ipcRenderer.invoke("mori-mail:detail", { id }),
  openGmail: () => ipcRenderer.invoke("mori-mail:open-gmail"),
  close: () => ipcRenderer.invoke("mori-mail:close"),
  setZoom: zoom => ipcRenderer.invoke("mori-mail:zoom", zoom),
  setSize: size => ipcRenderer.invoke("mori-mail:size", size),
  resizeGrip: phase => ipcRenderer.invoke("mori-mail:resize-grip", phase),
  setPinned: pinned => ipcRenderer.invoke("mori-mail:pin", pinned),
  setAutoOpen: enabled => ipcRenderer.invoke("mori-mail:auto-open", enabled),
  setNotification: enabled => ipcRenderer.invoke("mori-mail:notify", enabled),
  setQuiet: (start, end) => ipcRenderer.invoke("mori-mail:quiet", { start, end }),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on("mori-mail:changed", listener);
    return () => ipcRenderer.removeListener("mori-mail:changed", listener);
  },
});
