"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeHudSnapshot, mergeDisplayState } = require("../src/mori-desktop-snapshot");
const { getDirectSendFocusTarget } = require("../src/session-focus");

test("browser merge preserves the original CLI snapshot and its consumers", () => {
  const original = { sessions: [{ id: "cli", state: "working", badge: "running" }], orderedIds: ["cli"], accountQuota: [] };
  const before = structuredClone(original);
  const browser = { id: "browser:one", source: "browser", state: "attention", phase: "settled", pendingNotice: { noticeSequence: 1 }, displayTitle: "ChatGPT 1" };
  const merged = mergeHudSnapshot(original, [browser]);
  assert.deepEqual(original, before);
  assert.equal(merged.sessions.length, 2);
  assert.deepEqual(merged.orderedIds, ["browser:one", "cli"]);
  assert.equal(merged.hudLastTitle, "ChatGPT 1");
  assert.deepEqual(original.orderedIds, ["cli"]);
});

test("CLI permission is higher priority and heartbeat does not change browser order", () => {
  const cli = { sessions: [{ id: "permission", state: "notification", badge: "running" }], orderedIds: ["permission"] };
  const rows = [
    { id: "browser:b", source: "browser", phase: "running", badge: "running", phaseChangedAt: 2, lastConnectionAt: 100 },
    { id: "browser:a", source: "browser", phase: "running", badge: "running", phaseChangedAt: 1, lastConnectionAt: 200 },
  ];
  const ids = mergeHudSnapshot(cli, rows).orderedIds;
  rows[1].lastConnectionAt = 100000;
  assert.deepEqual(mergeHudSnapshot(cli, rows).orderedIds, ids);
  assert.equal(ids[0], "permission");
});

test("browser character candidate cannot overwrite CLI approval or DND", () => {
  assert.equal(mergeDisplayState("idle", "working"), "working");
  assert.equal(mergeDisplayState("working", "attention"), "attention");
  assert.equal(mergeDisplayState("notification", "attention"), "notification");
  assert.equal(mergeDisplayState("idle", "working", { permissionLocked: true }), "idle");
  assert.equal(mergeDisplayState("sleeping", "working", { dnd: true }), "sleeping");
});

test("a browser row cannot inherit terminal paste capabilities", () => {
  const target = getDirectSendFocusTarget({ id: "browser:one", source: "browser", sourcePid: 123, agentId: "codex" });
  assert.equal(target.canFocus, false);
  assert.equal(target.reason, "browser_navigation_only");
  assert.equal(target.url, null);
});
