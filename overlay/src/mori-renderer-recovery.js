"use strict";

const RECOVERABLE = new Set(["crashed", "oom", "killed", "launch-failed"]);
const WINDOW_MS = 60_000;
const MAX_RELOADS = 2;

function attachRendererRecovery(webContents, { isActive, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onExhausted = () => {} }) {
  let attempts = [];
  let timer = null;
  let disposed = false;
  let exhausted = false;
  function gone(_event, details) {
    if (disposed || !isActive() || !RECOVERABLE.has(details?.reason) || timer) return;
    const time = now();
    attempts = attempts.filter(value => time - value < WINDOW_MS);
    if (attempts.length >= MAX_RELOADS) {
      if (!exhausted) { exhausted = true; onExhausted(); }
      return;
    }
    attempts.push(time);
    timer = setTimer(() => {
      timer = null;
      if (disposed || !isActive() || webContents.isDestroyed?.()) return;
      try { webContents.reload(); }
      catch { /* Manual app relaunch remains available. */ }
    }, 250);
  }
  webContents.on("render-process-gone", gone);
  return () => {
    disposed = true;
    if (timer) clearTimer(timer);
    timer = null;
    webContents.removeListener?.("render-process-gone", gone);
  };
}

module.exports = { attachRendererRecovery };
