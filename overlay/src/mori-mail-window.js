"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installClientConfig } = require("./mori-calendar-client-config");
const { ID_RE } = require("./mori-mail-core");
const { openJsonFile } = require("./browser-bridge-persistence");
const hudLayout = require("./mori-hud-layout");

function createMailWindow({ BrowserWindow, ipcMain, dialog, clipboard, shell, screen,
  runtime, dataDir, getPetBounds, getOtherBounds = () => null, getSuppressed = () => false,
  openGoogleSetup = () => ({ ok: false, reason: "unavailable" }) }) {
  let window = null, positionTimer = null, automaticSession = false;
  let autoWanted = false, disposed = false, focusOnLoad = false, suppressionClosing = false;
  let acceptManualMove = false, lastPlacedBounds = null, resizeGesture = null, layout = null;
  try { layout = openJsonFile(path.join(dataDir, "layout.json"), hudLayout.valid,
    { maxBytes: 1000 }); } catch { /* Optional layout cannot block mail. */ }
  let placement = hudLayout.read(layout?.value);
  const pagePath = path.join(__dirname, "mori-mail.html");
  const pageUrl = pathToFileURL(pagePath).href;
  const channels = [];
  function trusted(event) {
    return !!window && !window.isDestroyed() && event?.sender === window.webContents
      && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pageUrl;
  }
  function handle(channel, action) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!trusted(event)) return { ok: false, reason: "untrusted-sender" };
      try { return await action(payload); }
      catch { return { ok: false, reason: "operation-failed" }; }
    });
    channels.push(channel);
  }
  handle("mori-mail:state", () => ({ ok: true, ...runtime.snapshot(), zoom: placement.zoom,
    pinned: placement.pinned, autoOpen: placement.autoOpen,
    width: placement.width, height: placement.height, sizeMode: hudLayout.sizeMode(placement) }));
  handle("mori-mail:auto-open", value => {
    if (typeof value !== "boolean") return { ok: false, reason: "invalid-auto-open" };
    const previous = placement.autoOpen;
    placement.autoOpen = value;
    if (!saveLayout()) { placement.autoOpen = previous; return { ok: false, reason: "storage-error" }; }
    return { ok: true, autoOpen: value };
  });
  handle("mori-mail:pin", value => {
    if (typeof value !== "boolean") return { ok: false, reason: "invalid-pin" };
    placement.pinned = value;
    window.setAlwaysOnTop(value);
    saveLayout();
    return { ok: true, pinned: value };
  });
  handle("mori-mail:zoom", value => {
    if (!hudLayout.ZOOMS.includes(value)) return { ok: false, reason: "invalid-zoom" };
    placement.zoom = value;
    window.webContents.setZoomFactor?.(value);
    saveLayout();
    return { ok: true, zoom: value };
  });
  handle("mori-mail:size", value => {
    if (typeof value !== "string" || (value !== "custom" && !Object.hasOwn(hudLayout.SIZES, value)))
      return { ok: false, reason: "invalid-size" };
    const previous = { ...placement };
    const area = screen.getDisplayNearestPoint(window.getBounds()).workArea;
    const target = value === "custom" ? { width: placement.freeWidth || placement.width,
      height: placement.freeHeight || placement.height } : hudLayout.SIZES[value];
    const bounds = hudLayout.clamp({ ...window.getBounds(), ...target }, area);
    if (value !== "custom" && hudLayout.sizeMode(placement) === "custom") {
      placement.freeWidth = placement.width; placement.freeHeight = placement.height;
    }
    Object.assign(placement, bounds, { manual: true, sizeMode: value });
    if (!saveLayout()) { placement = previous; return { ok: false, reason: "storage-error" }; }
    setPlacedBounds(bounds);
    return { ok: true, width: bounds.width, height: bounds.height };
  });
  handle("mori-mail:resize-grip", phase => {
    if (phase === "start") {
      const cursor = screen.getCursorScreenPoint?.();
      if (!cursor || !Number.isSafeInteger(cursor.x) || !Number.isSafeInteger(cursor.y))
        return { ok: false, reason: "cursor-unavailable" };
      resizeGesture = { bounds: window.getBounds(), cursor };
      return { ok: true };
    }
    if (!resizeGesture) return { ok: false, reason: "resize-not-started" };
    if (phase === "move") {
      const cursor = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(resizeGesture.bounds).workArea;
      const bounds = hudLayout.gripBounds(resizeGesture.bounds, resizeGesture.cursor, cursor, area);
      Object.assign(placement, bounds, { manual: true, sizeMode: "custom",
        freeWidth: bounds.width, freeHeight: bounds.height });
      setPlacedBounds(bounds);
      return { ok: true, width: bounds.width, height: bounds.height };
    }
    if (phase === "end") {
      resizeGesture = null;
      return saveLayout() ? { ok: true } : { ok: false, reason: "storage-error" };
    }
    return { ok: false, reason: "invalid-resize-phase" };
  });
  handle("mori-mail:refresh", async () => ({ ok: true, ...await runtime.refresh(true) }));
  handle("mori-mail:more", async () => ({ ok: true, ...await runtime.loadMore() }));
  handle("mori-mail:connect", async () => ({ ok: true, ...await runtime.connect() }));
  handle("mori-mail:disconnect", () => ({ ok: true, ...runtime.disconnect() }));
  handle("mori-mail:senders", payload => runtime.setSenders(payload?.senders));
  handle("mori-mail:hide", payload => runtime.hide(payload?.id));
  handle("mori-mail:detail", payload => runtime.detail(payload?.id));
  handle("mori-mail:import", async () => {
    if (!runtime.canImportClient()) return { ok: false, reason: "disconnect-first" };
    const selected = await dialog.showOpenDialog(window, { title: "Gmail 用 Desktop OAuth 設定を選択",
      properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (selected.canceled || selected.filePaths.length !== 1) return { ok: false, reason: "cancelled" };
    try { installClientConfig(selected.filePaths[0], dataDir); }
    catch { return { ok: false, reason: "invalid-config-file" }; }
    return runtime.reloadClient();
  });
  handle("mori-mail:open-google-setup", () => openGoogleSetup());
  handle("mori-mail:open-link", async payload => {
    if (!ID_RE.test(payload?.id || "")) return { ok: false, reason: "invalid-message" };
    const url = runtime.link(payload.id);
    if (!url) return { ok: false, reason: "invalid-link" };
    await shell.openExternal(url);
    return { ok: true };
  });
  handle("mori-mail:copy-link", payload => {
    if (!ID_RE.test(payload?.id || "")) return { ok: false, reason: "invalid-message" };
    const url = runtime.link(payload.id);
    if (!url) return { ok: false, reason: "invalid-link" };
    clipboard.writeText(url);
    return { ok: true };
  });
  handle("mori-mail:close", () => { autoWanted = false; window?.close(); return { ok: true }; });
  function position() {
    if (!window || window.isDestroyed()) return;
    if (placement.manual) {
      const area = screen.getDisplayNearestPoint(placement).workArea;
      const safe = hudLayout.clamp(placement, area);
      if (safe.x !== placement.x || safe.y !== placement.y
        || safe.width !== placement.width || safe.height !== placement.height) {
        Object.assign(placement, safe); setPlacedBounds(safe); saveLayout();
      }
      return;
    }
    const pet = getPetBounds?.();
    if (!pet) return;
    const area = screen.getDisplayNearestPoint({ x: pet.x + pet.width / 2,
      y: pet.y + pet.height / 2 }).workArea;
    setPlacedBounds(hudLayout.automatic(pet, area, placement, getOtherBounds()));
  }
  function setPlacedBounds(bounds) {
    const current = window.getBounds();
    if (current.x === bounds.x && current.y === bounds.y && current.width === bounds.width
      && current.height === bounds.height) return;
    lastPlacedBounds = bounds;
    window.setBounds(bounds);
  }
  function placeSavedPosition() {
    const area = screen.getDisplayNearestPoint(placement).workArea;
    setPlacedBounds(hudLayout.clamp(placement, area));
  }
  function saveLayout() {
    if (!layout) return false;
    try { layout.write({ ...placement, version: 2 }); return true; } catch { return false; }
  }
  function tick() {
    if (disposed) return;
    if (automaticSession && getSuppressed()) {
      if (window && !window.isDestroyed()) { suppressionClosing = true; window.close(); }
      return;
    }
    if ((!window || window.isDestroyed()) && autoWanted) { open({ automatic: true }); return; }
    position();
  }
  function open({ automatic = false } = {}) {
    if (automatic) autoWanted = true;
    else { autoWanted = false; automaticSession = false; }
    if (!positionTimer) positionTimer = setInterval(tick, 1000);
    if (automatic && getSuppressed()) return { ok: false, reason: "suppressed" };
    if (window && !window.isDestroyed()) {
      if (window.isMinimized?.()) window.restore();
      window.show(); if (!automatic) window.focus(); return { ok: true }; }
    automaticSession = automatic;
    focusOnLoad = !automatic;
    window = new BrowserWindow({ width: placement.width, height: placement.height,
      minWidth: 320, minHeight: 300,
      show: false, frame: false, transparent: true, resizable: true,
      skipTaskbar: false, alwaysOnTop: placement.pinned, backgroundColor: "#00000000",
      webPreferences: { preload: path.join(__dirname, "preload-mori-mail.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
    lastPlacedBounds = null; resizeGesture = null; acceptManualMove = false;
    window.on("move", () => {
      if (!acceptManualMove || !window || window.isDestroyed()) return;
      const bounds = window.getBounds();
      if (lastPlacedBounds && bounds.x === lastPlacedBounds.x && bounds.y === lastPlacedBounds.y) return;
      placement.manual = true; placement.x = bounds.x; placement.y = bounds.y;
    });
    window.on("moved", () => { if (!resizeGesture) saveLayout(); });
    window.on("resize", () => {
      if (!acceptManualMove || !window || window.isDestroyed()) return;
      const bounds = window.getBounds();
      if (lastPlacedBounds && bounds.width === lastPlacedBounds.width && bounds.height === lastPlacedBounds.height) return;
      placement.width = bounds.width; placement.height = bounds.height;
      placement.x = bounds.x; placement.y = bounds.y;
      placement.sizeMode = "custom"; placement.freeWidth = bounds.width; placement.freeHeight = bounds.height;
    });
    window.on("resized", () => { if (!resizeGesture) saveLayout(); });
    if (placement.manual) placeSavedPosition(); else position();
    window.webContents.once("did-finish-load", () => {
      if (window && !window.isDestroyed()) {
        window.webContents.setZoomFactor?.(placement.zoom);
        if (focusOnLoad) { window.show(); window.focus(); } else window.showInactive();
        acceptManualMove = true;
      }
    });
    window.loadFile(pagePath);
    window.on("closed", () => {
      resizeGesture = null;
      saveLayout(); acceptManualMove = false; window = null; runtime.clearBody();
      if (!suppressionClosing) autoWanted = false;
      suppressionClosing = false;
      if (!autoWanted && positionTimer) { clearInterval(positionTimer); positionTimer = null; }
    });
    return { ok: true };
  }
  function notify() { if (window && !window.isDestroyed()) window.webContents.send("mori-mail:changed"); }
  function dispose() {
    disposed = true; autoWanted = false;
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (positionTimer) clearInterval(positionTimer);
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }
  return { open, notify, dispose, autoOpenEnabled: () => placement.autoOpen,
    getBounds: () => window && !window.isDestroyed() ? window.getBounds() : null };
}

module.exports = { createMailWindow };
