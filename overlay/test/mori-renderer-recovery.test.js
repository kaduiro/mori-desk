"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachRendererRecovery } = require("../src/mori-renderer-recovery");

test("renderer recovery reloads only a live crashed page and stops repeated failures", () => {
  const webContents = new EventEmitter();
  let alive = true, clock = 0, pending = null, reloads = 0, exhausted = 0;
  webContents.reload = () => { reloads++; };
  webContents.isDestroyed = () => false;
  const detach = attachRendererRecovery(webContents, { isActive: () => alive,
    now: () => clock, setTimer: fn => { pending = fn; return 1; },
    clearTimer: () => { pending = null; }, onExhausted: () => { exhausted++; } });
  webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  assert.equal(pending, null);
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(typeof pending, "function");
  pending(); pending = null;
  assert.equal(reloads, 1);
  clock = 1000;
  webContents.emit("render-process-gone", {}, { reason: "oom" });
  pending(); pending = null;
  assert.equal(reloads, 2);
  clock = 2000;
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(exhausted, 1);
  assert.equal(pending, null);
  clock = 61_001;
  webContents.emit("render-process-gone", {}, { reason: "crashed" });
  alive = false;
  pending(); pending = null;
  assert.equal(reloads, 2);
  detach();
  assert.equal(webContents.listenerCount("render-process-gone"), 0);
});
