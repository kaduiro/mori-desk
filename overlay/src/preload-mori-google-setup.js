"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("moriGoogleSetup", {
  state: () => ipcRenderer.invoke("mori-google-setup:state"),
  save: value => ipcRenderer.invoke("mori-google-setup:save", value),
  prompt: () => ipcRenderer.invoke("mori-google-setup:prompt"),
  copyPrompt: () => ipcRenderer.invoke("mori-google-setup:copy-prompt"),
});
