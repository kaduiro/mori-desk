/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('moriMeasurement', Object.freeze({
  status: () => ipcRenderer.invoke('mori-measurement:status'),
  pair: () => ipcRenderer.invoke('mori-measurement:pair'),
  copyPair: () => ipcRenderer.invoke('mori-measurement:copy-pair'),
  openProductUI: () => ipcRenderer.invoke('mori-measurement:open-product-ui'),
  export: () => ipcRenderer.invoke('mori-measurement:export'),
}));
