"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { safeHttps } = require("./mori-calendar-core");
const { openJsonFile } = require("./browser-bridge-persistence");
const hudLayout = require("./mori-hud-layout");
const { attachRendererRecovery } = require("./mori-renderer-recovery");

function createCalendarWindow({ BrowserWindow, ipcMain, shell, screen, runtime,
  getPetBounds, getOtherBounds = () => null, getSuppressed, dataDir,
  openSetup = () => ({ ok: false, reason: "unavailable" }) }) {
  let window = null;
  let detachRecovery = null;
  let positionTimer = null;
  let automaticSession = false;
  let autoWanted = false;
  let disposed = false;
  let focusOnLoad = false;
  let suppressionClosing = false;
  let acceptManualMove = false;
  let lastPlacedBounds = null;
  let resizeGesture = null;
  let layout = null;
  try {
    if (dataDir) layout = openJsonFile(path.join(dataDir, "layout.json"), hudLayout.valid, { maxBytes: 1000 });
  } catch { /* A corrupt optional layout must not prevent the calendar from opening. */ }
  let placement = hudLayout.read(layout?.value);
  const pagePath = path.join(__dirname, "mori-calendar.html");
  const pageUrl = pathToFileURL(pagePath).href;
  const channels = [];

  function trusted(event) {
    return !!window && !window.isDestroyed()
      && event?.sender === window.webContents
      && event.senderFrame === event.sender.mainFrame
      && event.senderFrame.url === pageUrl;
  }
  function handle(channel, action) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!trusted(event)) return { ok: false, reason: "untrusted-sender" };
      try { return await action(payload); }
      catch { return { ok: false, reason: "operation-failed" }; }
    });
    channels.push(channel);
  }
  handle("mori-calendar:state", () => ({ ok: true, ...runtime.snapshot(), zoom: placement.zoom,
    pinned: placement.pinned, autoOpen: placement.autoOpen,
    width: placement.width, height: placement.height, sizeMode: hudLayout.sizeMode(placement) }));
  handle("mori-calendar:auto-open", value => {
    if (typeof value !== "boolean") return { ok: false, reason: "invalid-auto-open" };
    const previous = placement.autoOpen;
    placement.autoOpen = value;
    if (!saveLayout()) { placement.autoOpen = previous; return { ok: false, reason: "storage-error" }; }
    return { ok: true, autoOpen: value };
  });
  handle("mori-calendar:pin", value => {
    if (typeof value !== "boolean") return { ok: false, reason: "invalid-pin" };
    placement.pinned = value;
    window.setAlwaysOnTop(value);
    saveLayout();
    return { ok: true, pinned: value };
  });
  handle("mori-calendar:zoom", value => {
    if (!hudLayout.ZOOMS.includes(value)) return { ok: false, reason: "invalid-zoom" };
    placement.zoom = value;
    window.webContents.setZoomFactor?.(value);
    saveLayout();
    return { ok: true, zoom: value };
  });
  handle("mori-calendar:size", value => {
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
  handle("mori-calendar:resize-grip", phase => {
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
  handle("mori-calendar:connect", () => runtime.connect());
  handle("mori-calendar:refresh", () => runtime.refresh(true));
  handle("mori-calendar:calendars", () => runtime.loadCalendars(true));
  handle("mori-calendar:select", payload => runtime.selectCalendars(payload?.ids));
  handle("mori-calendar:disconnect", () => runtime.disconnect());
  handle("mori-calendar:close", () => { autoWanted = false; window?.close(); return { ok: true }; });
  handle("mori-calendar:open-setup", () => openSetup());
  handle("mori-calendar:open-link", async payload => {
    if (typeof payload?.id !== "string" || !/^[a-f0-9]{32}$/.test(payload.id)) return { ok: false, reason: "invalid-event" };
    const event = runtime.snapshot().events.find(item => item.key === payload.id);
    const url = safeHttps(event?.url);
    if (!url) return { ok: false, reason: "invalid-url" };
    await shell.openExternal(url);
    return { ok: true };
  });
  handle("mori-calendar:copy-link", payload => {
    if (typeof payload?.id !== "string" || !/^[a-f0-9]{32}$/.test(payload.id)) return { ok: false, reason: "invalid-event" };
    const event = runtime.snapshot().events.find(item => item.key === payload.id);
    const url = safeHttps(event?.url);
    if (!url) return { ok: false, reason: "invalid-url" };
    const { clipboard } = require("electron");
    clipboard.writeText(url);
    return { ok: true };
  });

  function setPlacedBounds(bounds) {
    const current = window.getBounds();
    if (current.x === bounds.x && current.y === bounds.y
      && current.width === bounds.width && current.height === bounds.height) return;
    lastPlacedBounds = bounds;
    window.setBounds(bounds);
  }
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
    const area = screen.getDisplayNearestPoint({ x: pet.x + pet.width / 2, y: pet.y + pet.height / 2 }).workArea;
    setPlacedBounds(hudLayout.automatic(pet, area, placement, getOtherBounds()));
  }
  function placeSavedPosition() {
    const area = screen.getDisplayNearestPoint(placement).workArea;
    setPlacedBounds(hudLayout.clamp(placement, area));
  }
  function saveLayout() {
    if (!layout) return false;
    try { layout.write({ ...placement, version: 2 }); return true; }
    catch { return false; /* Dragging still works for this session if persistence fails. */ }
  }
  function tick() {
    if (disposed) return;
    if (automaticSession && getSuppressed?.()) {
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
    if (automatic && getSuppressed?.()) return { ok: false, reason: "suppressed" };
    if (window && !window.isDestroyed()) {
      position(); if (window.isMinimized?.()) window.restore();
      window.show(); if (!automatic) window.focus(); return { ok: true };
    }
    automaticSession = automatic;
    focusOnLoad = !automatic;
    window = new BrowserWindow({
      width: placement.width, height: placement.height, minWidth: 320, minHeight: 300, show: false,
      frame: false, transparent: true, resizable: true, skipTaskbar: false,
      alwaysOnTop: placement.pinned,
      backgroundColor: "#00000000",
      webPreferences: { preload: path.join(__dirname, "preload-mori-calendar.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const created = window;
    detachRecovery = attachRendererRecovery(created.webContents, {
      isActive: () => !disposed && window === created && !created.isDestroyed(),
      onExhausted: () => console.warn("Mori Calendar renderer recovery stopped after repeated failures."),
    });
    lastPlacedBounds = null;
    resizeGesture = null;
    acceptManualMove = false;
    window.on("move", () => {
      if (!acceptManualMove || !window || window.isDestroyed()) return;
      const bounds = window.getBounds();
      if (lastPlacedBounds && bounds.x === lastPlacedBounds.x && bounds.y === lastPlacedBounds.y) return;
      placement.manual = true;
      placement.x = bounds.x; placement.y = bounds.y;
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
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", event => event.preventDefault());
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
      detachRecovery?.(); detachRecovery = null;
      resizeGesture = null;
      saveLayout();
      acceptManualMove = false;
      window = null;
      if (!suppressionClosing) autoWanted = false;
      suppressionClosing = false;
      if (!autoWanted && positionTimer) { clearInterval(positionTimer); positionTimer = null; }
    });
    return { ok: true };
  }
  function notify() {
    if (window && !window.isDestroyed()) window.webContents.send("mori-calendar:changed");
  }
  function dispose() {
    disposed = true; autoWanted = false;
    detachRecovery?.(); detachRecovery = null;
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (positionTimer) clearInterval(positionTimer);
    positionTimer = null;
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }
  return { open, notify, dispose, autoOpenEnabled: () => placement.autoOpen,
    getBounds: () => window && !window.isDestroyed() ? window.getBounds() : null };
}

module.exports = { createCalendarWindow };
