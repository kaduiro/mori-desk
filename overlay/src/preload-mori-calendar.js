"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("moriCalendar", {
  state: () => ipcRenderer.invoke("mori-calendar:state"),
  connect: () => ipcRenderer.invoke("mori-calendar:connect"),
  refresh: () => ipcRenderer.invoke("mori-calendar:refresh"),
  calendars: () => ipcRenderer.invoke("mori-calendar:calendars"),
  select: ids => ipcRenderer.invoke("mori-calendar:select", { ids }),
  disconnect: () => ipcRenderer.invoke("mori-calendar:disconnect"),
  close: () => ipcRenderer.invoke("mori-calendar:close"),
  setZoom: zoom => ipcRenderer.invoke("mori-calendar:zoom", zoom),
  setSize: size => ipcRenderer.invoke("mori-calendar:size", size),
  resizeGrip: phase => ipcRenderer.invoke("mori-calendar:resize-grip", phase),
  setPinned: pinned => ipcRenderer.invoke("mori-calendar:pin", pinned),
  setAutoOpen: enabled => ipcRenderer.invoke("mori-calendar:auto-open", enabled),
  setNotification: enabled => ipcRenderer.invoke("mori-calendar:notify", enabled),
  setQuiet: (start, end) => ipcRenderer.invoke("mori-calendar:quiet", { start, end }),
  reminderAction: (key, action) => ipcRenderer.invoke("mori-calendar:reminder-action", { key, action }),
  openSetup: () => ipcRenderer.invoke("mori-calendar:open-setup"),
  openLink: id => ipcRenderer.invoke("mori-calendar:open-link", { id }),
  copyLink: id => ipcRenderer.invoke("mori-calendar:copy-link", { id }),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on("mori-calendar:changed", listener);
    return () => ipcRenderer.removeListener("mori-calendar:changed", listener);
  },
});
