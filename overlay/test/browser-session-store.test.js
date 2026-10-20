const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { createBrowserSessionStore, STALE_MS, MAX_ACTIVE } = require("../src/browser-session-store");
const { validateEvent } = require("../src/browser-bridge-protocol");
const coordinator = require("../extensions/browser-bridge/session-coordinator");
const providerUtils = require("../extensions/browser-bridge/provider-utils");

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

test("optional conversation metadata accepts normalized short text and rejects malformed or unbounded content", (t) => {
  const f = fixture(t);
  const legacy = f.event();
  assert.deepEqual(validateEvent(legacy), legacy);
  for (const text of ["", "営業会議の準備", "相談 👩‍💻", "x".repeat(160)]) {
    const event = f.event({ conversationTitle: text, requestPreview: text });
    assert.deepEqual(validateEvent(event), event);
  }
  for (const key of ["conversationTitle", "requestPreview"]) {
    for (const invalid of [undefined, null, 42, {}, ["text"], "x".repeat(161), " leading", "trailing ",
      "two  spaces", "line\nbreak", "tab\tseparated", "nonbreaking\u00a0space", "line\u2028separator",
      "control\u0000", "control\u0085", "bidi\u202e", "isolate\u2067", "broken\ud800", "broken\udc00"]) {
      assert.throws(() => validateEvent(f.event({ [key]: invalid })), { code: "invalid_metadata" }, key);
    }
  }
  for (const forbidden of ["answer", "prompt", "html", "cookie", "apiKey", "summary", "metadata"]) {
    assert.throws(() => validateEvent(f.event({ [forbidden]: "not an allowed field" })), { code: "invalid_schema" });
  }
});

test("fresh conversation metadata identifies a row while local names keep priority and receipts stay unchanged", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ conversationTitle: "営業資料", requestPreview: "来週の提案の構成を考えて" }));
  let row = f.store.getSnapshot()[0];
  const id = row.id;
  const notice = row.noticeSequence;
  assert.equal(row.displayTitle, "営業資料");
  assert.equal(row.sessionTitle, "営業資料");
  assert.equal(row.requestPreview, "来週の提案の構成を考えて");
  assert.equal(row.isCurrent, true);
  assert.equal(row.isHistory, false);
  f.store.setLabel(id, "提案の準備");
  f.advance(1);
  f.store.ingest("client-1", f.event({ sequence: 3, phase: "settled", outcome: "completed",
    conversationTitle: "営業資料の改訂", requestPreview: "費用の説明も加えて" }));
  row = f.store.getSnapshot()[0];
  assert.equal(row.displayTitle, "提案の準備");
  assert.equal(row.conversationTitle, "営業資料の改訂");
  assert.equal(row.noticeSequence, notice);
  assert.equal(row.unreadCount, 1);
  f.store.setLabel(id, "");
  assert.equal(f.store.getSnapshot()[0].displayTitle, "営業資料の改訂");
  f.store.ingest("client-1", f.event({ sequence: 4, conversationTitle: "", requestPreview: "" }));
  row = f.store.getSnapshot()[0];
  assert.equal(row.displayTitle, "ChatGPT 1");
  assert.equal(row.conversationTitle, "");
  assert.equal(row.requestPreview, "");
});

test("SPA route and document changes clear obsolete descriptions, including saved invalidations", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event({ conversationTitle: "最初の会話", requestPreview: "最初の依頼" }));
  const id = f.store.getSnapshot()[0].id;
  f.store.setLabel(id, "最初の会話の名前");
  f.store.ingest("client-1", f.event({ sequence: 2, routeRevision: 1, conversationRef: "/c/second",
    conversationTitle: "", requestPreview: "" }));
  let row = f.store.getSnapshot()[0];
  assert.equal(row.id, id);
  assert.equal(row.conversationTitle, "");
  assert.equal(row.requestPreview, "");
  assert.equal(row.customLabel, "");
  assert.equal(row.displayTitle, "ChatGPT 1");
  f.store.ingest("client-1", f.event({ sequence: 3, routeRevision: 1, conversationRef: "/c/second",
    conversationTitle: "二つ目の会話", requestPreview: "二つ目の依頼" }));
  const target = f.store.getFocusTarget(id);
  f.store.ingest("client-1", f.event({ sequence: 4, routeRevision: 2, conversationRef: "/c/second",
    pageInstanceId: "document-2", observation: "stale", replay: true,
    conversationTitle: "二つ目の会話", requestPreview: "古い画面に残っていた依頼" }));
  row = f.store.getSnapshot()[0];
  assert.equal(row.conversationTitle, "");
  assert.equal(row.requestPreview, "");
  assert.equal(row.pageInstanceId, "document-2");
  assert.equal(row.status, "unknown");
  assert.equal(row.isCurrent, true);
  assert.equal(f.store.matchesFocusTarget(target), false);
  f.store.ingest("client-1", f.event({ sequence: 5, routeRevision: 2, conversationRef: "/c/second",
    pageInstanceId: "document-2", conversationTitle: "読み込み後の会話", requestPreview: "確認できた依頼" }));
  // A legacy sender has no metadata keys. Crossing another document boundary
  // must still remove the previous document's description.
  f.store.ingest("client-1", f.event({ sequence: 6, routeRevision: 3, conversationRef: "/c/second", pageInstanceId: "document-3" }));
  row = f.store.getSnapshot()[0];
  assert.equal(row.conversationTitle, "");
  assert.equal(row.requestPreview, "");
});

test("metadata never rolls back for out-of-order, stale or replayed events but remains independent of generation support", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event({ conversationTitle: "最初", requestPreview: "最初の依頼" }));
  f.advance(100);
  f.store.ingest("client-1", f.event({ sequence: 3, conversationTitle: "最新", requestPreview: "最新の依頼" }));
  f.store.ingest("client-1", f.event({ sequence: 2, conversationTitle: "順序が古い", requestPreview: "古い依頼" }));
  f.store.ingest("client-1", f.event({ sequence: 4, observedAt: f.now() - 50, routeRevision: 1, pageInstanceId: "obsolete-document",
    observation: "stale", replay: true, conversationTitle: "古い画面", requestPreview: "古い依頼" }));
  assert.equal(f.store.getSnapshot()[0].pageInstanceId, "document-1");
  f.store.ingest("client-1", f.event({ sequence: 4, observedAt: f.now() - 50,
    conversationTitle: "時刻が古い", requestPreview: "古い依頼" }));
  f.store.ingest("client-1", f.event({ sequence: 5, observation: "stale", replay: true,
    conversationTitle: "再送", requestPreview: "古い依頼" }));
  f.store.ingest("client-1", f.event({ sequence: 6, observedAt: f.now() - STALE_MS - 1,
    conversationTitle: "期限切れ", requestPreview: "古い依頼" }));
  let row = f.store.getSnapshot()[0];
  assert.equal(row.conversationTitle, "最新");
  assert.equal(row.requestPreview, "最新の依頼");
  f.advance(1);
  f.store.ingest("client-1", f.event({ sequence: 7, observation: "unsupported",
    conversationTitle: "状態判定に未対応の会話", requestPreview: "経路を確認できた依頼" }));
  row = f.store.getSnapshot()[0];
  assert.equal(row.conversationTitle, "状態判定に未対応の会話");
  assert.equal(row.requestPreview, "経路を確認できた依頼");
  assert.equal(row.status, "unsupported");
  assert.equal(row.isCurrent, true);
});

test("same browser-run reconnect and desktop restart reuse a row while waiting for a fresh observation", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ conversationTitle: "再接続する会話", requestPreview: "作業中の依頼" }));
  const before = f.store.getSnapshot()[0];
  f.store.disconnect("client-1", "run-1");
  assert.equal(f.store.getSnapshot()[0].isHistory, true);
  f.store.connect("client-1", "run-1");
  let row = f.store.getSnapshot()[0];
  assert.equal(row.id, before.id);
  assert.equal(row.isCurrent, true);
  assert.equal(row.isHistory, false);
  assert.equal(row.statusReason, "awaiting_observation");
  f.store.ingest("client-1", f.event({ sequence: 3, observation: "stale", replay: true }));
  const restarted = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  restarted.connect("client-1", "run-1");
  assert.equal(restarted.getSnapshot().length, 1);
  row = restarted.getSnapshot()[0];
  assert.equal(row.id, before.id);
  assert.equal(row.isCurrent, true);
  assert.equal(row.status, "unknown");
  assert.equal(row.conversationTitle, "再接続する会話");
  assert.equal(row.noticeSequence, before.noticeSequence);
  restarted.ingest("client-1", f.event({ sequence: 4 }));
  assert.equal(restarted.getSnapshot().length, 1);
  assert.equal(restarted.getSnapshot()[0].status, "generating");
});

test("browser restart separates current tabs from history and restores local names without combining receipts", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ conversationTitle: "会話のタイトル", requestPreview: "再起動前の依頼" }));
  const before = f.store.getSnapshot()[0];
  f.store.setLabel(before.id, "インターンの相談");
  f.store.connect("client-1", "run-2");
  f.store.ingest("client-1", f.event({ browserRunId: "run-2", sessionId: "reopened", pageInstanceId: "document-2",
    conversationTitle: "会話のタイトル", requestPreview: "再開した依頼" }));
  f.store.ingest("client-1", f.event({ browserRunId: "run-2", sessionId: "another-tab", tabId: 2, pageInstanceId: "document-3",
    conversationTitle: "会話のタイトル", requestPreview: "別のタブの依頼" }));
  const rows = f.store.getSnapshot();
  const history = rows.find(row => row.id === before.id);
  const current = rows.filter(row => row.isCurrent);
  assert.equal(rows.length, 3);
  assert.equal(history.isHistory, true);
  assert.equal(history.canFocus, false);
  assert.equal(history.noticeSequence, before.noticeSequence);
  assert.equal(history.unreadCount, 1);
  assert.equal(current.length, 2);
  for (const row of current) {
    assert.equal(row.customLabel, "インターンの相談");
    assert.equal(row.displayTitle, "インターンの相談");
    assert.equal(row.isHistory, false);
    assert.equal(row.unreadCount, 0);
    assert.equal(f.store.getFocusTarget(row.id).pageInstanceId, row.pageInstanceId);
  }
  assert.notEqual(current[0].id, current[1].id);
  assert.notEqual(current[0].tabId, current[1].tabId);
  f.store.setLabel(current[0].id, "片方のタブの名前");
  assert.equal(f.store.getSnapshot().find(row => row.id === current[1].id).customLabel, "インターンの相談");
});

test("real coordinator A to B to A keeps history descriptions, local names and unread receipts attached to their conversation", (t) => {
  const f = fixture(t);
  let state = coordinator.newState("run-1");
  let identities = 0;
  let observations = 0;
  const uuid = () => `coordinator-${++identities}`;
  function deliver(result) {
    state = result.state;
    for (const event of result.events) f.store.ingest("client-1", event);
  }
  function observe(conversation, pageInstanceId, conversationTitle, requestPreview, patch = {}) {
    f.advance(1);
    deliver(coordinator.reduceObservation(state, {
      type: "mori.observation", v: 1, pageInstanceId, contentSequence: ++observations,
      observedAt: f.now(), status: "idle", generationToken: null, outcome: null,
      conversationTitle, requestPreview, ...patch,
    }, { tabId: 1, documentId: "document-1", route: providerUtils.routeForUrl(`https://chatgpt.com/c/${conversation}`) },
    { uuid, now: f.now() }));
  }
  function invalidate() {
    f.advance(1);
    deliver(coordinator.invalidateTab(state, 1, { uuid, now: f.now() }));
  }

  observe("a", "page-a", "会話 A", "A への依頼", { status: "running", generationToken: "generation-a" });
  observe("a", "page-a", "会話 A", "A への依頼", { status: "settled", generationToken: "generation-a", outcome: "unverified" });
  const originalA = f.store.getSnapshot()[0];
  f.store.setLabel(originalA.id, "手動の A");
  const capturedFocus = f.store.getFocusTarget(originalA.id);
  invalidate();
  assert.equal(f.store.matchesFocusTarget(capturedFocus), false);
  assert.equal(f.store.getSnapshot()[0].conversationTitle, "会話 A");
  assert.equal(f.store.getSnapshot()[0].requestPreview, "A への依頼");

  observe("b", "page-b", "会話 B", "B への依頼");
  let rows = f.store.getSnapshot();
  let oldA = rows.find(row => row.id === originalA.id);
  const b = rows.find(row => row.isCurrent);
  assert.equal(rows.filter(row => row.isCurrent).length, 1);
  assert.equal(oldA.isHistory, true);
  assert.equal(oldA.conversationTitle, "会話 A");
  assert.equal(oldA.requestPreview, "A への依頼");
  assert.equal(oldA.customLabel, "手動の A");
  assert.equal(oldA.noticeSequence, originalA.noticeSequence);
  assert.equal(oldA.unreadCount, 1);
  assert.equal(b.conversationRef, "/c/b");
  assert.equal(b.conversationTitle, "会話 B");
  assert.equal(b.requestPreview, "B への依頼");
  assert.equal(b.customLabel, "");
  assert.equal(b.unreadCount, 0);
  assert.notEqual(b.id, originalA.id);

  invalidate();
  observe("a", "page-a-return", "会話 A", "A への依頼");
  rows = f.store.getSnapshot();
  const currentA = rows.find(row => row.isCurrent);
  oldA = rows.find(row => row.id === originalA.id);
  const oldB = rows.find(row => row.id === b.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.isCurrent).length, 1);
  assert.equal(currentA.conversationRef, "/c/a");
  assert.equal(currentA.conversationTitle, "会話 A");
  assert.equal(currentA.requestPreview, "A への依頼");
  assert.equal(currentA.customLabel, "手動の A");
  assert.equal(currentA.unreadCount, 0);
  assert.notEqual(currentA.id, originalA.id);
  assert.equal(oldA.isHistory, true);
  assert.equal(oldA.noticeSequence, originalA.noticeSequence);
  assert.equal(oldA.unreadCount, 1);
  assert.equal(oldB.isHistory, true);
  assert.equal(oldB.conversationTitle, "会話 B");
  assert.equal(oldB.requestPreview, "B への依頼");
  assert.equal(oldB.customLabel, "");
});

test("manual names never cross profile, provider, different conversation or unknown-conversation boundaries", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  f.store.setLabel(f.store.getSnapshot()[0].id, "この会話だけ");
  f.store.ingest("client-1", f.event({ sessionId: "different", tabId: 2, conversationRef: "/c/different" }));
  f.store.ingest("client-1", f.event({ sessionId: "claude", tabId: 3, provider: "claude", conversationRef: "/chat/conversation-1" }));
  f.store.connect("client-2", "run-1");
  f.store.ingest("client-2", f.event());
  for (const row of f.store.getSnapshot().filter(row => row.sessionId !== "session-1" || row.clientId !== "client-1")) {
    assert.equal(row.customLabel, "");
  }
  f.store.ingest("client-1", f.event({ sessionId: "unnamed-1", tabId: 4, conversationRef: null }));
  const unnamed = f.store.getSnapshot().find(row => row.sessionId === "unnamed-1");
  f.store.setLabel(unnamed.id, "新規会話の名前");
  f.store.ingest("client-1", f.event({ sessionId: "unnamed-2", tabId: 5, conversationRef: null }));
  assert.equal(f.store.getSnapshot().find(row => row.sessionId === "unnamed-2").customLabel, "");
  f.store.ingest("client-1", f.event({ sequence: 2, sessionId: "unnamed-1", tabId: 4, routeRevision: 1, conversationRef: "/c/assigned" }));
  assert.equal(f.store.getSnapshot().find(row => row.sessionId === "unnamed-1").customLabel, "新規会話の名前");
});

test("clearing a local name prevents an older name from returning on a later reopened tab", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event());
  f.store.ingest("client-1", f.event({ sessionId: "already-open", tabId: 2 }));
  const first = f.store.getSnapshot().find(row => row.sessionId === "session-1");
  const second = f.store.getSnapshot().find(row => row.sessionId === "already-open");
  f.store.setLabel(first.id, "以前の名前");
  // This row has no label of its own; an explicit blank still supersedes the
  // older alias for subsequent reopenings, without changing the other tab.
  f.store.setLabel(second.id, "");
  const file = path.join(f.dataDir, "sessions.json");
  const afterClear = fs.readFileSync(file, "utf8");
  f.store.setLabel(second.id, "");
  assert.equal(fs.readFileSync(file, "utf8"), afterClear);
  const restarted = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  restarted.connect("client-1", "run-2");
  restarted.ingest("client-1", f.event({ browserRunId: "run-2", sessionId: "reopened" }));
  assert.equal(restarted.getSnapshot().find(row => row.sessionId === "reopened").customLabel, "");
  assert.equal(restarted.getSnapshot().find(row => row.id === first.id).customLabel, "以前の名前");
});

test("old terminal replay keeps its original history title and cannot rename or revive current tabs", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.event({ conversationTitle: "再起動前の会話", requestPreview: "保存済みの依頼" }));
  const original = f.store.getSnapshot()[0];
  f.store.connect("client-1", "run-2");
  f.store.ingest("client-1", f.event({ browserRunId: "run-2", sessionId: "current", pageInstanceId: "document-2",
    conversationTitle: "現在の会話", requestPreview: "現在の依頼" }));
  const replay = f.terminal({ replay: true, conversationTitle: "遅れて届いたタイトル", requestPreview: "遅れて届いた依頼" });
  f.store.ingest("client-1", replay);
  let history = f.store.getSnapshot().find(row => row.id === original.id);
  assert.equal(history.isHistory, true);
  assert.equal(history.isCurrent, false);
  assert.equal(history.conversationTitle, "再起動前の会話");
  assert.equal(history.requestPreview, "保存済みの依頼");
  assert.equal(history.unreadCount, 1);
  assert.equal(history.canFocus, false);
  assert.equal(f.store.ingest("client-1", replay).duplicate, true);
  assert.throws(() => f.store.ingest("client-1", { ...replay, conversationTitle: "書き換え" }), { code: "event_id_conflict" });
  const current = f.store.getSnapshot().find(row => row.sessionId === "current");
  assert.equal(current.conversationTitle, "現在の会話");
  assert.equal(current.unreadCount, 0);
  // A history row missing from disk can still retain its own short identifying
  // text when its durable terminal first arrives, without becoming current.
  f.store.ingest("client-1", f.terminal({ sessionId: "missing-history", replay: true,
    conversationTitle: "履歴の会話", requestPreview: "履歴の依頼" }));
  history = f.store.getSnapshot().find(row => row.sessionId === "missing-history");
  assert.equal(history.conversationTitle, "履歴の会話");
  assert.equal(history.isHistory, true);
  assert.equal(history.canFocus, false);
});

test("old stores and pre-metadata receipt fingerprints load without losing unread or local names", (t) => {
  const f = fixture(t);
  const terminal = f.terminal();
  f.store.ingest("client-1", terminal);
  const file = path.join(f.dataDir, "sessions.json");
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  delete old.nextLabelSequence;
  old.sessions[0].customLabel = "旧版で付けた名前";
  const legacyFields = [terminal.eventId, terminal.browserRunId, terminal.sessionId, terminal.sequence, terminal.kind, terminal.provider,
    terminal.tabId, terminal.pageInstanceId, terminal.routeRevision, terminal.conversationRef,
    terminal.turnId, terminal.generation, terminal.phase, terminal.outcome, terminal.observation, terminal.observedAt];
  old.receipts[0].fingerprint = crypto.createHash("sha256").update(JSON.stringify(legacyFields)).digest("hex");
  fs.writeFileSync(file, JSON.stringify(old));
  const restored = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  restored.connect("client-1", "run-1");
  let row = restored.getSnapshot()[0];
  assert.equal(row.displayTitle, "旧版で付けた名前");
  assert.equal(row.conversationTitle, "");
  assert.equal(row.requestPreview, "");
  assert.equal(row.unreadCount, 1);
  assert.equal(restored.ingest("client-1", { ...terminal, replay: true }).duplicate, true);
  restored.connect("client-1", "run-2");
  restored.ingest("client-1", f.event({ browserRunId: "run-2", sessionId: "new-version", conversationTitle: "新しく取得したタイトル" }));
  row = restored.getSnapshot().find(row => row.sessionId === "new-version");
  assert.equal(row.displayTitle, "旧版で付けた名前");
  assert.equal(row.conversationTitle, "新しく取得したタイトル");
  assert.equal(row.unreadCount, 0);
});

test("persisted metadata and local-name ordering are validated before any history is restored", (t) => {
  const f = fixture(t);
  f.store.ingest("client-1", f.terminal({ conversationTitle: "保存する会話", requestPreview: "保存する依頼" }));
  f.store.setLabel(f.store.getSnapshot()[0].id, "ローカル名");
  const file = path.join(f.dataDir, "sessions.json");
  const valid = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const patch of [
    { conversationTitle: 42 }, { conversationTitle: "x".repeat(161) }, { requestPreview: "改行\n付き" },
    { requestPreview: "hidden\u202e" }, { requestPreview: "broken\ud800" }, { metadataObservedAt: "yesterday" },
    { customLabelSequence: -1 }, { customLabelSequence: valid.nextLabelSequence + 1 },
  ]) {
    const corrupt = { ...valid, sessions: [{ ...valid.sessions[0], ...patch }] };
    fs.writeFileSync(file, JSON.stringify(corrupt));
    fs.writeFileSync(`${file}.bak`, JSON.stringify(corrupt));
    assert.throws(() => createBrowserSessionStore({ dataDir: f.dataDir, now: f.now }), /unreadable/);
  }
});
