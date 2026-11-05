/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Development composition only: the actual product panel and HUD renderer use
// the collector's ONE bridge/store. No application main, CLI, tray or userData.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const createBrowserPanel = require('../src/mori-browser-window');
const { mergeHudSnapshot } = require('../src/mori-desktop-snapshot');
const { getBrowserStatus } = require('../src/mori-browser-status');
const { i18n } = require('../src/i18n');

function createProductUI({ BrowserWindow, ipcMain, clipboard, collector, buildInfo } = {}) {
  if (!collector || typeof collector.getProductBridge !== 'function') throw new Error('native_ui_configuration');
  let hud = null, disposed = false, pinned = false;
  const hudPage = pathToFileURL(path.resolve(__dirname, '../src/session-hud.html')).href;
  const listenerStatus = () => {
    const state = collector.snapshot();
    // getStatus does not own the listener port. The explicit collector method
    // supplies it; never discover/reuse another application's listening socket.
    const bound = collector.getProductPort?.();
    return { state: state.status === 'running' && Number.isSafeInteger(bound) ? 'listening' : 'stopped', port: bound ?? null };
  };
  const getBridge = () => {
    const bridge = collector.getProductBridge();
    if (!bridge) return null;
    // Product pairing goes through the same lifetime/expiry gate as the
    // collector UI. It cannot bypass an expired measurement by opening a panel.
    return { ...bridge, beginPairing() {
      const result = collector.beginPairing();
      if (!result.ok) { const error = new Error('measurement_pairing_unavailable'); error.code = 'measurement_pairing_unavailable'; throw error; }
      const { ok, ...pair } = result; return pair;
    } };
  };
  const panel = createBrowserPanel({ BrowserWindow, ipcMain, clipboard: { writeText(value) {
    if (collector.snapshot().pairing?.canCopy !== true) {
      const error = new Error('measurement_pairing_unavailable'); error.code = 'measurement_pairing_unavailable'; throw error;
    }
    clipboard.writeText(value);
  } },
    shell: { openPath: async () => '計測専用拡張は指定された読み込み先を使ってください。' },
    getBridge, getPort: () => listenerStatus().port, getHudWindow: () => hud,
    cliEnabled: false, getListenerStatus: listenerStatus, getBuildInfo: () => buildInfo,
    getLoginStatus: () => ({ state: 'unavailable', enabled: null, reason: 'isolated_measurement' }) });

  function trustedHud(event) {
    return !disposed && hud && !hud.isDestroyed() && event?.sender === hud.webContents
      && event.senderFrame === hud.webContents.mainFrame && event.senderFrame.url === hudPage;
  }
  const handlers = [];
  function handle(name, fn) {
    ipcMain.handle(name, (event, value) => trustedHud(event) ? fn(value) : { ok: false, reason: 'untrusted-sender' });
    handlers.push(name);
  }
  function hudSnapshot() {
    const bridge = getBridge(), listener = listenerStatus();
    const snapshot = mergeHudSnapshot({ sessions: [], orderedIds: [], hudShowStateLabels: true,
      hudShowElapsed: true, hudShowContextUsage: false, hudShowQuota: false, hudPinned: pinned, accountQuota: [] },
    bridge?.getSnapshot() || []);
    const status = getBrowserStatus({ bridge: bridge?.getStatus() || null, port: listener.port, listener });
    snapshot.moriBrowserStatus = { state: status.state, dnd: false,
      providers: status.providers.map(({ provider, state, fresh, discovered, unmonitored, detail }) => ({
        provider, state, ...(Number.isSafeInteger(fresh) ? { fresh, discovered, unmonitored, detail } : {}) })) };
    return snapshot;
  }
  function notify() {
    if (disposed) return;
    panel.notify();
    if (hud && !hud.isDestroyed()) hud.webContents.send('session-hud:session-snapshot', hudSnapshot());
  }
  handle('session-hud:get-i18n', () => ({ lang: 'ja', translations: i18n.ja }));
  handle('session-hud:open-session-folder', () => ({ ok: false, reason: 'browser-only' }));
  handle('session:ack-completion', () => ({ ok: false, reason: 'browser-only' }));
  const pin = (event, value) => { if (trustedHud(event) && typeof value === 'boolean') { pinned = value; notify(); } };
  ipcMain.on('session-hud:set-pinned', pin);
  function open() {
    if (disposed) return { ok: false, reason: 'disposed' };
    panel.open();
    if (!hud || hud.isDestroyed()) {
      hud = new BrowserWindow({ width: 420, height: 430, title: 'MORI 計測専用 · 製品HUD（隔離）',
        autoHideMenuBar: true,
        webPreferences: { preload: path.resolve(__dirname, '../src/preload-session-hud.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true } });
      const target = hud;
      target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      target.webContents.on('will-navigate', event => event.preventDefault());
      target.webContents.on('did-finish-load', notify);
      target.on('closed', () => { if (hud === target) hud = null; });
      void target.loadURL(hudPage);
    } else { hud.show(); hud.focus(); }
    notify(); return { ok: true };
  }
  return Object.freeze({ open, notify,
    // Window presence is operational readiness, NOT proof that a particular
    // receipt was rendered, nor acceptance of native HUD geometry/positioning.
    summary: () => ({ enabled: !disposed, hudOpen: !!hud && !hud.isDestroyed(),
      sameBridgeStore: true, applicationEndpointVerified: false, nativeHudHostVerified: false }),
    dispose() {
      if (disposed) return; disposed = true; panel.dispose();
      handlers.forEach(name => ipcMain.removeHandler(name)); ipcMain.removeListener('session-hud:set-pinned', pin);
      if (hud && !hud.isDestroyed()) hud.destroy(); hud = null;
    } });
}
module.exports = { createProductUI };
