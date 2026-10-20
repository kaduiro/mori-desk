"use strict";
const { isBrowserHistory } = require("./mori-hud-status");

function priority(row) {
  if (row.source !== "browser" && ["notification", "error"].includes(row.state)) return 0;
  if (row.source === "browser" && (row.pendingNotice || row.requiresCompletionAck || row.outcome === "error")) return 1;
  if (row.badge === "running" || row.phase === "running") return 2;
  return 3;
}

// Called only at the local HUD/panel boundary. The CLI snapshot, recap, LAN
// consumers and notification services retain their original inputs.
function mergeHudSnapshot(cliSnapshot, browserRows = []) {
  const base = cliSnapshot || { sessions: [], orderedIds: [] };
  const history = browserRows.filter(isBrowserHistory);
  const current = browserRows.filter(row => !isBrowserHistory(row));
  const sessions = [...(base.sessions || []), ...current];
  const baseOrder = new Map((base.orderedIds || []).map((id, i) => [id, i]));
  sessions.sort((a, b) => priority(a) - priority(b)
    || (a.source === "browser" && b.source === "browser"
      ? (Number(b.phaseChangedAt) || 0) - (Number(a.phaseChangedAt) || 0)
      : (baseOrder.get(a.id) ?? 1000) - (baseOrder.get(b.id) ?? 1000))
    || String(a.id).localeCompare(String(b.id)));
  const visible = sessions.filter(row => !row.headless && row.state !== "sleeping" && !row.hiddenFromHud);
  const historyUnread = history.reduce((sum, row) => sum + (Number.isSafeInteger(row.unreadCount)
    ? Math.max(0, row.unreadCount) : (row.pendingNotice || row.requiresCompletionAck ? 1 : 0)), 0);
  const firstHistory = history.find(row => row.pendingNotice || row.requiresCompletionAck || row.unreadCount > 0) || history[0];
  return { ...base, sessions, orderedIds: sessions.map(row => row.id),
    moriBrowserHistory: { count: history.length, unreadCount: historyUnread, firstSessionId: firstHistory?.id || null },
    hudTotalNonIdle: visible.length, hudLastTitle: visible[0]?.displayTitle || null };
}

function mergeDisplayState(cliState, browserState, { permissionLocked = false, dnd = false } = {}) {
  if (dnd || permissionLocked || ["error", "notification", "sweeping", "attention"].includes(cliState)) return cliState;
  if (browserState === "attention") return "attention";
  if (browserState === "working" && ["idle", "sleeping", "thinking"].includes(cliState)) return "working";
  return cliState;
}

module.exports = { mergeHudSnapshot, mergeDisplayState };
