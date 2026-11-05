/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProductUI } = require('../scripts/native-measurement-product-ui');

function harness() {
  const windows = [], handlers = new Map();
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.messages = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.send = (name, payload) => this.messages.push([name, payload]);
      windows.push(this);
    }
    async loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
    async loadFile(file) { return this.loadURL(require('node:url').pathToFileURL(file).href); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    show() {} focus() {}
  }
  const ipc = new EventEmitter();
  ipc.handle = (name, fn) => { if (handlers.has(name)) throw new Error('duplicate'); handlers.set(name, fn); };
  ipc.removeHandler = name => handlers.delete(name);
  let pairAllowed = true, pairCalls = 0, copies = 0, ack = null;
  const bridge = {
    getStatus: () => ({ clients: [], clientHealth: [], pairingAvailable: true, state: 'ready' }),
    getSnapshot: () => [],
    ack: (id, noticeSequence) => { ack = { id, noticeSequence }; return { ok: true }; },
  };
  const collector = { snapshot: () => ({ status: 'running', pairing: { canCopy: pairAllowed } }), getProductPort: () => 23337,
    getProductBridge: () => bridge, beginPairing: () => {
      pairCalls++; return pairAllowed ? { ok: true, code: 'PRIVATE_CODE', expiresAt: Date.now() + 60000 } : { ok: false, reason: 'expired' };
    } };
  const ui = createProductUI({ BrowserWindow: Window, ipcMain: ipc, clipboard: { writeText() { copies++; } }, collector });
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { ui, windows, ipc, handlers, event, disablePair: () => { pairAllowed = false; },
    getPairCalls: () => pairCalls, getCopies: () => copies, getAck: () => ack };
}
test('isolated product UI composes actual panel and HUD with one bridge and trusted exact ACK', async () => {
  const h = harness();
  try {
    assert.equal(h.ui.open().ok, true);
    assert.equal(h.windows.length, 2);
    const [panel, hud] = h.windows;
    assert.match(panel.webContents.mainFrame.url, /mori-browser\.html$/);
    assert.match(hud.webContents.mainFrame.url, /session-hud\.html$/);
    assert.match(hud.options.webPreferences.preload, /preload-session-hud\.js$/);
    assert.equal(hud.options.webPreferences.sandbox, true);
    assert.equal(hud.openHandler({ url: 'https://example.com' }).action, 'deny');
    assert.ok(hud.messages.some(([name]) => name === 'session-hud:session-snapshot'));
    const ack = h.handlers.get('mori:ack');
    assert.equal((await ack(h.event(hud), { id: 'local', noticeSequence: 7 })).ok, true);
    assert.deepEqual(h.getAck(), { id: 'local', noticeSequence: 7 });
    assert.equal((await ack({ sender: hud.webContents, senderFrame: { url: hud.webContents.mainFrame.url } },
      { id: 'bad', noticeSequence: 8 })).ok, false);
    assert.deepEqual(h.getAck(), { id: 'local', noticeSequence: 7 });
    h.ui.open(); assert.equal(h.windows.length, 2);
    assert.deepEqual(h.ui.summary(), { enabled: true, hudOpen: true, sameBridgeStore: true,
      applicationEndpointVerified: false, nativeHudHostVerified: false });
    assert.equal(JSON.stringify(h.ui.summary()).includes('PRIVATE_CODE'), false);
    h.ui.notify();
  } finally { h.ui.dispose(); }
  assert.equal(h.handlers.size, 0);
  assert.equal(h.ipc.listenerCount('session-hud:set-pinned'), 0);
  assert.ok(h.windows.every(w => w.isDestroyed()));
  assert.equal(h.ui.open().ok, false);
});
test('product panel cannot renew pairing through the isolated UI after collector expiry', async () => {
  const h = harness();
  try {
    h.ui.open();
    assert.equal((await h.handlers.get('mori:pair')(h.event(h.windows[0]))).ok, true);
    h.disablePair();
    // Cached product code is still inside its own TTL. The measurement's
    // independent lifetime gate must nevertheless reject the copy.
    const copy = await h.handlers.get('mori:copy-pair-code')(h.event(h.windows[0]));
    assert.equal(copy.ok, false);
    assert.equal(copy.reason, 'measurement_pairing_unavailable');
    assert.equal(h.getCopies(), 0);
    const result = await h.handlers.get('mori:pair')(h.event(h.windows[0]));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'measurement_pairing_unavailable');
    assert.equal(h.getPairCalls(), 2);
    assert.equal(JSON.stringify(result).includes('PRIVATE_CODE'), false);
  } finally { h.ui.dispose(); }
});
