/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Standalone development collector. Does not import the application's main,
// native hooks, tray, CLI integrations, or ordinary Mori userData.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, safeStorage, clipboard, shell } = require('electron');
const { createNativeCollector } = require('./native-measurement-collector');
const kit = path.resolve(__dirname, '../native-measurement');
const descriptor = JSON.parse(fs.readFileSync(path.join(kit, 'kit.json'), 'utf8'));
if (descriptor.schema !== 1 || !/^[a-p]{32}$/.test(descriptor.extensionId || '')
  || !/^[a-f0-9]{64}$/.test(descriptor.sourceFingerprint || '')
  || !Number.isSafeInteger(descriptor.targetPingOrdinal) || descriptor.targetPingOrdinal < 2
  || descriptor.targetPingOrdinal > 60) throw new Error('native_kit_invalid');
for (const [name, hash] of Object.entries(descriptor.hashes || {})) {
  if (!/^[a-z0-9.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash)
    || crypto.createHash('sha256').update(fs.readFileSync(path.join(kit, 'extension', name))).digest('hex') !== hash)
    throw new Error('native_kit_modified');
}
app.setName('MORI Measurement Collector');
app.setPath('userData', path.join(kit, 'electron-user-data'));
app.setPath('sessionData', path.join(kit, 'electron-session-data'));
if (!app.requestSingleInstanceLock()) app.exit(1);
let collector, window, productUI, closing = false;
const page = pathToFileURL(path.join(__dirname, 'native-measurement.html')).href;
const captureDir = path.join(kit, `capture-${crypto.randomUUID()}`);
const report = path.join(kit, `collector-${crypto.randomUUID()}.json`);
function allowed(event) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === page;
}
async function shutdown() {
  if (closing) return;
  closing = true;
  try { try { productUI?.dispose(); } finally { await collector?.dispose(); } } finally { app.exit(0); }
}
app.on('before-quit', event => { if (!closing) { event.preventDefault(); void shutdown(); } });
app.whenReady().then(async () => {
  fs.mkdirSync(captureDir);
  const build = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/mori-build-info.json'), 'utf8'));
  const buildInfo = { desktopVersion: build.version, buildId: build.buildId, observerContract: 1 };
  collector = createNativeCollector({ dataDir: captureDir, safeStorage, extensionId: descriptor.extensionId,
    targetPingOrdinal: descriptor.targetPingOrdinal,
    maxDurationMs: 600000, buildInfo, kitSourceFingerprint: descriptor.sourceFingerprint,
    measurementBuildFingerprint: descriptor.measurementBuildFingerprint,
    onChange: () => productUI?.notify() });
  const started = await collector.start();
  if (process.argv.includes('--native-measurement-smoke')) {
    const encrypted = safeStorage.isEncryptionAvailable()
      && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
      && safeStorage.decryptString(safeStorage.encryptString('mori-measurement-smoke')) === 'mori-measurement-smoke';
    // The smoke report contains no pair code, credential, path or native token.
    fs.writeFileSync(path.join(kit, 'electron-smoke.json'), JSON.stringify({ schema: 1,
      environment: 'native_electron_windows', started: started.ok === true, safeStorageRoundTrip: !!encrypted,
      formalAcceptance: false, providerObserved: false }, null, 2) + '\n');
    process.stdout.write(`Native Electron collector smoke: ${started.ok && encrypted ? 'ready' : 'unavailable'}\n`);
    await collector.dispose(); closing = true; app.exit(started.ok && encrypted ? 0 : 1); return;
  }
  const { createProductUI } = require('./native-measurement-product-ui');
  productUI = createProductUI({ BrowserWindow, ipcMain, clipboard, shell, collector, buildInfo });
  window = new BrowserWindow({ width: 760, height: 850, title: 'MORI 計測専用コレクター',
    webPreferences: { preload: path.join(__dirname, 'native-measurement-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  ipcMain.handle('mori-measurement:status', event => {
    if (!allowed(event)) return { ok: false, reason: 'caller_rejected' };
    const snapshot = collector.snapshot();
    return { ok: snapshot.status === 'running', status: snapshot.status,
      category: snapshot.category, counts: snapshot.counts, capture: snapshot.capture,
      runtime: snapshot.runtime, pairing: snapshot.pairing, connection: snapshot.connection,
      productUI: productUI.summary() };
  });
  ipcMain.handle('mori-measurement:pair', event => {
    if (!allowed(event)) return { ok: false, reason: 'caller_rejected' };
    return collector.beginPairing();
  });
  ipcMain.handle('mori-measurement:copy-pair', event => {
    if (!allowed(event)) return { ok: false, reason: 'caller_rejected' };
    const result = collector.beginPairing();
    if (!result.ok) return { ok: false, reason: result.reason };
    if (typeof result.code !== 'string') return { ok: false, reason: 'pairing_unavailable' };
    try { clipboard.writeText(result.code); return { ok: true, reason: 'none' }; }
    catch { return { ok: false, reason: 'clipboard_unavailable' }; }
  });
  ipcMain.handle('mori-measurement:open-product-ui', event => {
    if (!allowed(event)) return { ok: false, reason: 'caller_rejected' };
    try { return productUI.open(); }
    catch { return { ok: false, reason: 'product_ui_unavailable' }; }
  });
  ipcMain.handle('mori-measurement:export', event => {
    if (!allowed(event)) return { ok: false, reason: 'caller_rejected' };
    try { fs.writeFileSync(report, JSON.stringify(collector.snapshot(), null, 2) + '\n', { mode: 0o600 });
      return { ok: true, path: report }; }
    catch { return { ok: false, reason: 'export_failed' }; }
  });
  await window.loadURL(page);
}).catch(async () => { process.stderr.write('Native collector could not start. Production data was not opened.\n');
  try { try { productUI?.dispose(); } finally { await collector?.dispose(); } } finally { closing = true; app.exit(1); } });
