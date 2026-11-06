"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("moriGoogleSetup", {
  state: () => ipcRenderer.invoke("mori-google-setup:state"),
  save: value => ipcRenderer.invoke("mori-google-setup:save", value),
});
