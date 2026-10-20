const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBrowserSessionStore, STALE_MS, MAX_ACTIVE } = require("../src/browser-session-store");

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-browser-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = 1000000;
  const notices = [];
  const store = createBrowserSessionStore({ dataDir, now: () => clock, onNotice: (notice) => notices.push(notice), ...options });
  store.connect("client-1", "run-1");
  function event(overrides = {}) {
    return { type: "event", v: 1, eventId: `event-${overrides.sequence || 1}`, browserRunId: "run-1", sessionId: "session-1",
      sequence: 1, kind: "observation", provider: "chatgpt", tabId: 1, pageInstanceId: "document-1", routeRevision: 0,
      conversationRef: "/c/conversation-1", turnId: "turn-1", generation: 1, phase: "running", outcome: null,
      observation: "fresh", observedAt: clock, replay: false, ...overrides };
  }
  function terminal(overrides = {}) {
    return event({ sequence: 2, kind: "terminal", phase: "settled", outcome: "completed", ...overrides });
  }
  return { store, dataDir, notices, event, terminal, advance(ms) { clock += ms; }, now: () => clock };
}

test("late completion creates a receipt without replacing the newer running turn", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  f.store.ingest("client-1", f.event({ sequence: 3, turnId: "turn-2", generation: 2 }));
  f.store.ingest("client-1", f.terminal({ replay: true }));
  const row = f.store.getSnapshot()[0];
  assert.equal(row.phase, "running");
  assert.equal(row.currentTurnId, "turn-2");
  assert.equal(row.pendingNotice.turnId, "turn-1");
  assert.equal(row.requiresCompletionAck, true);
  assert.equal(row.unreadCount, 1);
});

test("exactly one completion notice survives replay, acknowledgement, and restart", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  const terminal = f.terminal();
  f.store.ingest("client-1", terminal);
  const first = f.store.getSnapshot()[0];
  assert.equal(f.notices.length, 1);
  assert.equal(f.store.ingest("client-1", { ...terminal, replay: true }).duplicate, true);
  f.store.ack(first.id, first.noticeSequence);
  const restoredNotices = [];
  const restarted = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now, onNotice: (notice) => restoredNotices.push(notice) });
  restarted.connect("client-1", "run-1");
  assert.equal(restarted.ingest("client-1", { ...terminal, replay: true }).duplicate, true);
  assert.equal(restarted.getSnapshot()[0].requiresCompletionAck, false);
  assert.equal(restoredNotices.length, 0);
});

test("opening an existing settled conversation never manufactures a completion notice", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event({ phase: "settled", outcome: "completed" }));
  assert.equal(f.store.getSnapshot()[0].requiresCompletionAck, false);
  assert.equal(f.notices.length, 0);
});

test("heartbeats do not refresh DOM evidence, elapsed start, or visual activity", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  const before = f.store.getSnapshot()[0];
  f.advance(STALE_MS + 1);
  f.store.heartbeat("client-1");
  f.store.tick();
  const after = f.store.getSnapshot()[0];
  assert.equal(after.observation, "stale");
  assert.equal(after.status, "unknown");
  assert.equal(after.lastObservationAt, before.lastObservationAt);
  assert.equal(after.turnStartedAt, before.turnStartedAt);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.requiresCompletionAck, false);
});

test("restart preserves unread but requires new observation before treating running state as live", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  f.store.ingest("client-1", f.terminal());
  f.store.ingest("client-1", f.event({ sequence: 3, generation: 2, turnId: "turn-2" }));
  const restarted = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  restarted.connect("client-1", "run-1");
  assert.equal(restarted.getSnapshot()[0].status, "unknown");
  assert.equal(restarted.getSnapshot()[0].requiresCompletionAck, true);
  restarted.ingest("client-1", f.event({ sequence: 4, generation: 2, turnId: "turn-2" }));
  assert.equal(restarted.getSnapshot()[0].status, "generating");
});

test("old browser-run terminal is retained as history and cannot target a reused tab number", (t) => {
  const f = fixture(t);
  f.store.connect("client-1", "run-2");
  f.store.ingest("client-1", f.terminal({ replay: true }));
  const old = f.store.getSnapshot()[0];
  assert.equal(old.canFocus, false);
  assert.equal(f.store.getFocusTarget(old.id), null);
  assert.throws(() => f.store.ingest("client-1", f.event({ sequence: 3 })), { code: "stale_browser_run" });
});

test("acknowledging the notice captured before a new completion leaves the new receipt unread", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal());
  const captured = f.store.getSnapshot()[0];
  f.store.ingest("client-1", f.terminal({ sequence: 4, turnId: "turn-2", generation: 2 }));
  f.store.ack(captured.id, captured.noticeSequence);
  assert.equal(f.store.getSnapshot()[0].unreadCount, 1);
  assert.equal(f.store.getSnapshot()[0].pendingNotice.turnId, "turn-2");
  f.store.ack(captured.id, null);
  assert.equal(f.store.getSnapshot()[0].unreadCount, 1);
});

test("same conversation in two tabs has independent identity and focus targets", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  f.store.ingest("client-1", f.event({ sessionId: "session-2", tabId: 2 }));
  const rows = f.store.getSnapshot();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].conversationRef, rows[1].conversationRef);
});

test("closed or disconnected rows show observation loss while retaining prior unread outcome", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ outcome: "unverified" }));
  const id = f.store.getSnapshot()[0].id;
  f.store.disconnect("client-1", "run-1");
  let row = f.store.getSnapshot()[0];
  assert.equal(row.statusLabel, "ブラウザ未接続");
  assert.equal(row.statusReason, "disconnected");
  assert.equal(row.pendingNotice.outcome, "unverified");
  f.store.connect("client-1", "run-1");
  f.store.ingest("client-1", f.event({ sequence: 3, kind: "closed", phase: "settled", outcome: "unverified", observation: "closed" }));
  row = f.store.getSnapshot()[0];
  assert.equal(row.id, id);
  assert.equal(row.statusLabel, "タブを閉じました");
  assert.equal(row.pendingNotice.outcome, "unverified");
  assert.equal(row.canFocus, false);
});

test("reusing an event ID for different terminal data is rejected", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal());
  assert.throws(() => f.store.ingest("client-1", f.terminal({ outcome: "error", replay: true })), { code: "event_id_conflict" });
  assert.equal(f.store.getSnapshot()[0].unreadCount, 1);
});

test("a failed durable write does not consume the terminal or create an unread receipt", (t) => {
  let fail = false;
  const injectedFs = { ...fs, renameSync(from, to) {
    if (fail && to.endsWith("sessions.json")) throw new Error("injected disk failure");
    return fs.renameSync(from, to);
  } };
  const f = fixture(t, { fs: injectedFs });
  f.store.ingest("client-1", f.event());
  fail = true;
  assert.throws(() => f.store.ingest("client-1", f.terminal()), { code: "session_store_write_failed" });
  assert.equal(f.store.getSnapshot()[0].phase, "running");
  assert.equal(f.store.getSnapshot()[0].unreadCount, 0);
  assert.equal(f.notices.length, 0);
  fail = false;
  f.store.ingest("client-1", f.terminal());
  assert.equal(f.store.getSnapshot()[0].unreadCount, 1);
});

test("unread receipt corruption fails closed or restores only a known-good backup", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  f.store.ingest("client-1", f.terminal());
  const file = path.join(f.dataDir, "sessions.json");
  fs.writeFileSync(file, "{broken", "utf8");
  const recovered = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  assert.equal(recovered.getStatus().recovery, "recovered_backup");
  assert.equal(recovered.getSnapshot().length, 1);
  fs.writeFileSync(`${file}.bak`, "{also broken", "utf8");
  assert.throws(() => createBrowserSessionStore({ dataDir: f.dataDir, now: f.now }), /unreadable/);
});

test("active session capacity also gates reactivation of previously stale rows", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event({ sessionId: "old", tabId: 100 }));
  f.advance(STALE_MS + 1);
  for (let index = 0; index < MAX_ACTIVE; index++) {
    f.store.ingest("client-1", f.event({ sessionId: `active-${index}`, tabId: index }));
  }
  assert.throws(() => f.store.ingest("client-1", f.event({ sessionId: "old", tabId: 100, sequence: 2 })), { code: "active_session_limit" });
});

test("brief completion animation returns to work while unread remains visible", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal());
  f.store.ingest("client-1", f.event({ sessionId: "session-2", tabId: 2 }));
  assert.equal(f.store.getVisualState(), "attention");
  f.advance(5001);
  f.store.tick();
  assert.equal(f.store.getVisualState(), "working");
  assert.equal(f.store.getSnapshot().some((row) => row.requiresCompletionAck), true);
});

test("dismissed receipts cannot resurrect after replay and restart", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal());
  const row = f.store.getSnapshot()[0];
  f.store.dismiss(row.id);
  const restarted = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  restarted.connect("client-1", "run-1");
  restarted.ingest("client-1", f.terminal({ replay: true }));
  assert.equal(restarted.getSnapshot().length, 0);
});

test("offline tab closure after a browser restart preserves its known completion as closed history", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal());
  f.store.connect("client-1", "run-2");
  f.store.ingest("client-1", f.event({ sequence: 3, kind: "closed", observation: "closed", replay: true }));
  const row = f.store.getSnapshot()[0];
  assert.equal(row.outcome, "completed");
  assert.equal(row.observation, "closed");
  assert.equal(row.canFocus, false);
  assert.equal(row.requiresCompletionAck, true);
});

test("malformed persisted timestamps, receipt identity, or duplicate notice sequences are not trusted", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal());
  const file = path.join(f.dataDir, "sessions.json");
  const valid = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const corrupt of [
    { ...valid, sessions: [{ ...valid.sessions[0], lastObservationAt: "yesterday" }] },
    { ...valid, receipts: [{ ...valid.receipts[0], id: "another-row" }] },
    { ...valid, receipts: [...valid.receipts, { ...valid.receipts[0], key: `${valid.sessions[0].id}:another-event`, eventId: "another-event" }] },
  ]) {
    fs.writeFileSync(file, JSON.stringify(corrupt));
    fs.writeFileSync(`${file}.bak`, JSON.stringify(corrupt));
    assert.throws(() => createBrowserSessionStore({ dataDir: f.dataDir, now: f.now }), /unreadable/);
  }
});

test("reconnect and replayed invalidation never freshen prior DOM evidence", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  const started = f.store.getSnapshot()[0];
  f.store.disconnect("client-1", "run-1");
  f.store.connect("client-1", "run-1");
  assert.equal(f.store.getSnapshot()[0].observation, "stale");
  f.store.ingest("client-1", f.event({ sequence: 2, observation: "stale", replay: true, routeRevision: 1 }));
  assert.equal(f.store.getSnapshot()[0].status, "unknown");
  assert.equal(f.store.getSnapshot()[0].phaseChangedAt, started.phaseChangedAt);
  assert.equal(f.store.getSnapshot()[0].lastObservationAt, started.lastObservationAt);
  f.store.ingest("client-1", f.event({ sequence: 3, routeRevision: 1 }));
  assert.equal(f.store.getSnapshot()[0].status, "generating");
});

test("unknown state explains disconnected, restarted, reobserving and expired evidence independently", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ outcome: "unverified" }));
  const original = f.store.getSnapshot()[0];
  f.store.disconnect("client-1", "run-1");
  let row = f.store.getSnapshot()[0];
  assert.equal(row.statusReason, "disconnected");
  assert.equal(row.canFocus, false);
  assert.match(row.focusUnavailableReason, /接続/);
  assert.match(row.recoveryHint, /拡張機能/);

  f.store.connect("client-1", "run-2");
  row = f.store.getSnapshot()[0];
  assert.equal(row.statusReason, "browser_restarted");
  assert.equal(row.canFocus, false);
  assert.equal(f.store.getFocusTarget(row.id), null);
  assert.match(row.statusDetail, /保存された記録/);

  f.store.connect("client-1", "run-1");
  row = f.store.getSnapshot()[0];
  assert.equal(row.statusReason, "awaiting_observation");
  assert.equal(row.canFocus, true);
  assert.equal(row.focusUnavailableReason, "");
  f.store.ingest("client-1", f.event({ sequence: 3, phase: "settled", outcome: "unverified" }));
  f.advance(STALE_MS + 1);
  f.store.heartbeat("client-1");
  row = f.store.getSnapshot()[0];
  assert.equal(row.statusReason, "observation_expired");
  assert.match(row.statusDetail, /90 秒/);
  assert.equal(row.canFocus, true);
  assert.equal(row.lastObservationAt, original.lastObservationAt);
  assert.equal(row.requiresCompletionAck, true);
  assert.equal(row.noticeSequence, original.noticeSequence);
  assert.equal(row.outcome, "unverified");

  f.store.ingest("client-1", f.event({ sequence: 4, phase: "settled", outcome: "unverified", observation: "stale" }));
  assert.equal(f.store.getSnapshot()[0].statusReason, "observation_stale");
});

test("unsupported controls keep exact-tab navigation without claiming generation or acknowledging unread", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ outcome: "unverified" }));
  const original = f.store.getSnapshot()[0];
  f.store.ingest("client-1", f.event({ sequence: 3, phase: "settled", outcome: "unverified", observation: "unsupported" }));
  const row = f.store.getSnapshot()[0];
  assert.equal(row.status, "unsupported");
  assert.equal(row.statusReason, "unsupported");
  assert.equal(row.canFocus, true);
  assert.equal(row.focusUnavailableReason, "");
  assert.equal(row.requiresCompletionAck, true);
  const target = f.store.getFocusTarget(row.id, original.noticeSequence);
  assert.equal(target.tabId, original.tabId);
  assert.equal(target.pageInstanceId, original.pageInstanceId);
  assert.equal(target.noticeSequence, original.noticeSequence);
  assert.equal(f.store.matchesFocusTarget(target), true);
  f.store.ingest("client-1", f.event({ sequence: 4, phase: "settled", outcome: "unverified", observation: "unsupported", pageInstanceId: "next-document" }));
  assert.equal(f.store.matchesFocusTarget(target), false);
  assert.equal(f.store.getSnapshot()[0].unreadCount, 1);
  f.store.disconnect("client-1", "run-1");
  assert.equal(f.store.getSnapshot()[0].statusReason, "disconnected");
  assert.equal(f.store.getSnapshot()[0].statusLabel, "ブラウザ未接続");
  f.store.connect("client-1", "run-2");
  assert.equal(f.store.getSnapshot()[0].statusReason, "browser_restarted");
  assert.equal(f.store.getSnapshot()[0].canFocus, false);
});

test("explicit local names persist per row without changing identity, timestamps, phase or unread receipts", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ outcome: "unverified" }));
  f.store.ingest("client-1", f.event({ sessionId: "session-2", tabId: 2 }));
  const original = f.store.getSnapshot().find(row => row.tabId === 1);
  assert.deepEqual(f.store.setLabel(original.id, "  営業資料の作成  "), { ok: true });
  let row = f.store.getSnapshot().find(row => row.id === original.id);
  assert.equal(row.customLabel, "営業資料の作成");
  assert.equal(row.displayTitle, row.customLabel);
  assert.equal(row.label, "ChatGPT 1");
  for (const key of ["id", "tabId", "pageInstanceId", "routeRevision", "conversationRef", "phase", "outcome", "noticeSequence", "lastObservationAt", "phaseChangedAt", "updatedAt"]) assert.equal(row[key], original[key], key);
  assert.equal(f.store.getSnapshot().find(item => item.tabId === 2).displayTitle, "ChatGPT 2");

  const restarted = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  row = restarted.getSnapshot().find(item => item.id === original.id);
  assert.equal(row.customLabel, "営業資料の作成");
  assert.equal(row.requiresCompletionAck, true);
  assert.equal(row.statusReason, "disconnected");
  assert.deepEqual(restarted.setLabel(row.id, ""), { ok: true });
  assert.equal(restarted.getSnapshot().find(item => item.id === row.id).displayTitle, "ChatGPT 1");

  const beforeInvalid = fs.readFileSync(path.join(f.dataDir, "sessions.json"), "utf8");
  for (const invalid of ["x".repeat(81), "line\nbreak", "control\u0000", 42, null]) assert.deepEqual(restarted.setLabel(row.id, invalid), { ok: false, reason: "invalid_label" });
  assert.equal(fs.readFileSync(path.join(f.dataDir, "sessions.json"), "utf8"), beforeInvalid);
  assert.deepEqual(restarted.setLabel("missing-session", "名前"), { ok: false, reason: "session_missing" });
  assert.throws(() => f.store.ingest("client-1", { ...f.event({ sequence: 3 }), customLabel: "from-browser" }));
});
