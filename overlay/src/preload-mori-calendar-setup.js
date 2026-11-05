"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("moriCalendarSetup", {
  state: () => ipcRenderer.invoke("mori-calendar-setup:state"),
  importConfig: () => ipcRenderer.invoke("mori-calendar-setup:import"),
  connect: () => ipcRenderer.invoke("mori-calendar-setup:connect"),
  calendars: () => ipcRenderer.invoke("mori-calendar-setup:calendars"),
  select: ids => ipcRenderer.invoke("mori-calendar-setup:select", { ids }),
  disconnect: () => ipcRenderer.invoke("mori-calendar-setup:disconnect"),
  useManaged: () => ipcRenderer.invoke("mori-calendar-setup:use-managed"),
  openCalendar: () => ipcRenderer.invoke("mori-calendar-setup:open-calendar"),
  openBrowserPanel: () => ipcRenderer.invoke("mori-calendar-setup:open-browser"),
  openGoogleSetup: () => ipcRenderer.invoke("mori-calendar-setup:open-google-setup"),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on("mori-calendar-setup:changed", listener);
    return () => ipcRenderer.removeListener("mori-calendar-setup:changed", listener);
  },
});
