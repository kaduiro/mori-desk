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

test("only current browser tabs join local HUD sessions; previous receipts remain explicitly accessible", () => {
  const cli = { sessions: [{ id: "cli", state: "idle", badge: "done", displayTitle: "CLI result" }], orderedIds: ["cli"], remote: { untouched: true } };
  const browser = [
    { id: "history:first", source: "browser", isHistory: true, isCurrent: false, displayTitle: "以前の会話", unreadCount: 0 },
    { id: "current:one", source: "browser", isCurrent: true, isHistory: false, displayTitle: "インターン", conversationTitle: "インターン", requestPreview: "何から始めればいいですか", phase: "running", badge: "running" },
    { id: "history:unread", source: "browser", isHistory: true, displayTitle: "完了済みの会話", unreadCount: 2, pendingNotice: { noticeSequence: 5 } },
    { id: "current:legacy", source: "browser", displayTitle: "ChatGPT 2", phase: "idle", badge: "idle" },
    { id: "history:fallback", source: "browser", isCurrent: false, requiresCompletionAck: true },
  ];
  const before = structuredClone({ cli, browser });
  const merged = mergeHudSnapshot(cli, browser);
  assert.deepEqual(merged.orderedIds, ["current:one", "cli", "current:legacy"]);
  assert.equal(merged.hudTotalNonIdle, 3, "Previous records never inflate the current tab/CLI count");
  assert.equal(merged.hudLastTitle, "インターン");
  assert.deepEqual(merged.moriBrowserHistory, { count: 3, unreadCount: 3, firstSessionId: "history:unread" });
  assert.equal(merged.sessions.some(row => row.isHistory || row.isCurrent === false), false);
  assert.deepEqual({ cli, browser }, before, "The CLI snapshot and retained browser rows are not mutated");
  assert.equal("moriBrowserHistory" in cli, false, "Remote/recap consumers retain the unmerged input");
  assert.equal(JSON.stringify(cli).includes("何から始め"), false);
});

test("history-only HUD snapshot keeps a details target without counting or publishing the old sessions", () => {
  const merged = mergeHudSnapshot(null, [{ id: "old", source: "browser", isHistory: true, label: "ChatGPT 1", conversationTitle: "以前の会話", requestPreview: "以前の依頼", unreadCount: 0 }]);
  assert.deepEqual(merged.sessions, []);
  assert.deepEqual(merged.orderedIds, []);
  assert.equal(merged.hudTotalNonIdle, 0);
  assert.equal(merged.hudLastTitle, null);
  assert.deepEqual(merged.moriBrowserHistory, { count: 1, unreadCount: 0, firstSessionId: "old" });
  assert.equal(JSON.stringify(merged).includes("以前の依頼"), false);
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
