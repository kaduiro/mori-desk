const crypto = require("node:crypto");
const path = require("node:path");
const { openJsonFile } = require("./browser-bridge-persistence");
const { VERSION, isId, isInteger, desktopSessionId, validateEvent, normalizeConversationRef, protocolError } = require("./browser-bridge-protocol");

const STALE_MS = 90 * 1000;
const MAX_ACTIVE = 20;
const MAX_SESSIONS = 200;
const MAX_RECEIPTS = 4096;
const MAX_CUSTOM_LABEL_LENGTH = 80;

function isCustomLabel(value) {
  return typeof value === "string" && value.length <= MAX_CUSTOM_LABEL_LENGTH
    && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function eventFingerprint(event) {
  const { replay: _replay, ...body } = event;
  // Property order is fixed by this array, independent of sender JSON ordering.
  return crypto.createHash("sha256").update(JSON.stringify([
    body.eventId, body.browserRunId, body.sessionId, body.sequence, body.kind, body.provider,
    body.tabId, body.pageInstanceId, body.routeRevision, body.conversationRef,
    body.turnId, body.generation, body.phase, body.outcome, body.observation, body.observedAt,
  ])).digest("hex");
}

function validateStore(value) {
  if (value?.version !== VERSION || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS
    || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS
    || !isInteger(value.nextNoticeSequence) || !isInteger(value.labels?.chatgpt) || !isInteger(value.labels?.claude)) throw new Error("Invalid browser session store");
  const ids = new Set();
  for (const row of value.sessions) {
    if (![row.clientId, row.browserRunId, row.sessionId, row.pageInstanceId].every(isId)
      || row.id !== desktopSessionId(row.clientId, row.browserRunId, row.sessionId)
      || ids.has(row.id) || !["chatgpt", "claude"].includes(row.provider)
      || !isInteger(row.lastSequence) || !isInteger(row.generation) || !isInteger(row.acknowledgedThrough)
      || row.acknowledgedThrough > value.nextNoticeSequence || !isInteger(row.tabId) || !isInteger(row.routeRevision)
      || ![row.lastObservationAt, row.phaseChangedAt, row.createdAt].every((entry) => isInteger(entry))
      || (row.turnStartedAt !== null && !isInteger(row.turnStartedAt))
      || (row.currentTurnId !== null && !isId(row.currentTurnId))
      || (row.outcome !== null && !["completed", "interrupted", "error", "unverified"].includes(row.outcome))
      || typeof row.label !== "string" || !/^(ChatGPT|Claude) [1-9][0-9]{0,9}$/.test(row.label)
      || (row.customLabel !== undefined && !isCustomLabel(row.customLabel))
      || typeof row.dismissed !== "boolean"
      || !["idle", "running", "settled"].includes(row.phase)
      || !["fresh", "stale", "closed", "unsupported"].includes(row.observation)) throw new Error("Invalid browser session record");
    normalizeConversationRef(row.provider, row.conversationRef);
    ids.add(row.id);
  }
  const receiptIds = new Set();
  const noticeSequences = new Set();
  for (const receipt of value.receipts) {
    if (typeof receipt.key !== "string" || receiptIds.has(receipt.key) || !isInteger(receipt.noticeSequence, 1)
      || receipt.noticeSequence > value.nextNoticeSequence || noticeSequences.has(receipt.noticeSequence) || !ids.has(receipt.id)
      || !isId(receipt.eventId) || !isId(receipt.turnId)
      || receipt.key !== `${receipt.id}:${receipt.eventId}`
      || !isInteger(receipt.generation, 1) || !isInteger(receipt.observedAt, 1)
      || !["completed", "interrupted", "error", "unverified"].includes(receipt.outcome)
      || typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)) throw new Error("Invalid browser receipt");
    receiptIds.add(receipt.key);
    noticeSequences.add(receipt.noticeSequence);
  }
  for (const row of value.sessions) {
    if (row.acknowledgedThrough !== 0 && !value.receipts.some((receipt) => receipt.id === row.id && receipt.noticeSequence === row.acknowledgedThrough)) throw new Error("Invalid browser acknowledgement");
  }
}

function pendingReceipts(data, row) {
  return data.receipts.filter((receipt) => receipt.id === row.id && receipt.noticeSequence > row.acknowledgedThrough);
}

function effectiveObservation(row, now, activeRuns, restored) {
  if (row.observation === "closed") return "closed";
  if (activeRuns.get(row.clientId) !== row.browserRunId) return "stale";
  if (row.observation === "unsupported") return "unsupported";
  if (restored.has(row.id)
    || row.observation !== "fresh" || !row.lastObservationAt || now - row.lastObservationAt > STALE_MS) return "stale";
  return "fresh";
}

function observationDetails(row, status, now, activeRuns, restored) {
  const activeRun = activeRuns.get(row.clientId);
  let reason = status;
  if (status === "unknown") {
    if (!activeRun) reason = "disconnected";
    else if (activeRun !== row.browserRunId) reason = "browser_restarted";
    else if (restored.has(row.id) || !row.lastObservationAt) reason = "awaiting_observation";
    else if (row.observation !== "fresh") reason = "observation_stale";
    else if (now - row.lastObservationAt > STALE_MS) reason = "observation_expired";
  }
  const messages = {
    disconnected: ["ブラウザ未接続", "このセッションを通知していた拡張機能との接続が切れています。保存済みの状態を表示しています。", "Chrome と Mori Desk を起動し、拡張機能の設定で接続状態を確認してください。"],
    browser_restarted: ["再起動前のセッション", "この行は、現在接続中のブラウザとは別の起動時に保存された記録です。", "現在の AI タブを再読み込みし、新しく表示される行を確認してください。この行の未確認通知は保持されます。"],
    awaiting_observation: ["タブの状態を再取得中", "ブラウザは接続していますが、このタブの新しい状態をまだ受信していません。", "AI タブを表示し、状態が更新されない場合はタブを再読み込みしてください。拡張機能の「表示されない原因を確認」でも採用状況を調べられます。"],
    observation_stale: ["タブの状態を再取得中", "ページの切り替えなどにより、以前の観測を現在の状態として扱えません。", "対象の AI タブを表示し、必要に応じて再読み込みしてください。"],
    observation_expired: ["タブの状態更新が停止", "ブラウザとの接続はありますが、90 秒を超えてこのタブの新しい状態を受信していません。", "AI タブを表示し、状態が更新されない場合は再読み込みしてください。拡張機能の「表示されない原因を確認」で観測の採用結果を確認できます。"],
    unsupported: ["この画面には未対応", "このタブの画面から生成状態を判定できません。正常終了を確認したという意味ではありません。", "「タブへ戻る」で回答を確認してください。拡張機能の「表示されない原因を確認」で観測結果を調べられます。"],
    closed: ["タブを閉じました", "対象タブを閉じたため、保存済みの状態を表示しています。未確認の通知は保持されます。", "必要な回答をブラウザの履歴から確認してください。不要になった記録は一覧から削除できます。"],
    idle: ["待機中", "このタブの待機状態を受信しています。", ""],
    generating: ["生成中", "このタブの画面から生成中の状態を受信しています。", ""],
    completed: ["回答完了", "完了の通知を受信しました。回答は元のタブで確認できます。", ""],
    interrupted: ["生成を中断", "生成の中断を観測しました。回答は元のタブで確認してください。", ""],
    error: ["エラー", "AI の画面でエラーを観測しました。内容は元のタブで確認してください。", ""],
    unverified: ["回答を確認", "生成中の表示が消えました。正常終了は確定していないため、元のタブで回答を確認してください。", ""],
  };
  const [label, detail, recoveryHint] = messages[reason] || ["状態を確認できません", "このタブの新しい状態を確認できません。", "対象タブと拡張機能の接続状態を確認してください。"];
  const focusUnavailableReason = row.observation === "closed" ? "対象のタブは閉じられています。"
    : !activeRun ? "ブラウザとの接続がないため、タブへ戻れません。詳細で接続状態を確認してください。"
    : activeRun !== row.browserRunId ? "再起動前の記録です。現在のタブを再読み込みして、新しい行を確認してください。"
    : "";
  return { statusReason: reason, statusLabel: label, statusDetail: detail, recoveryHint, focusUnavailableReason };
}

function projectRow(data, row, now, activeRuns, restored, connectionTimes) {
  const receipts = pendingReceipts(data, row);
  const pending = receipts.at(-1) || null;
  const observation = effectiveObservation(row, now, activeRuns, restored);
  const fresh = observation === "fresh";
  let status = "idle";
  if (observation === "closed") status = "closed";
  else if (observation === "unsupported") status = "unsupported";
  else if (!fresh) status = "unknown";
  else if (row.phase === "running") status = "generating";
  else if (row.phase === "settled" && row.outcome) status = row.outcome;
  const details = observationDetails(row, status, now, activeRuns, restored);
  if (status === "completed" && pending) details.statusLabel = "回答完了・未確認";
  const displayTitle = row.customLabel || row.label;
  return {
    id: row.id, source: "browser", platform: "webui", agentId: `browser-${row.provider}`,
    provider: row.provider, label: row.label, customLabel: row.customLabel || "", sessionTitle: displayTitle, displayTitle,
    clientId: row.clientId, browserRunId: row.browserRunId, sessionId: row.sessionId,
    tabId: row.tabId, pageInstanceId: row.pageInstanceId, routeRevision: row.routeRevision,
    conversationRef: row.conversationRef, currentTurnId: row.currentTurnId, generation: row.generation,
    phase: row.phase, outcome: row.outcome, observation, status, ...details,
    state: status === "generating" ? "working" : status === "error" ? "error" : pending ? "attention" : "idle",
    badge: status === "generating" ? "running" : status === "unknown" ? "unknown" : status === "error" ? "error" : row.phase === "settled" ? "done" : "idle",
    requiresCompletionAck: !!pending, unreadCount: receipts.length,
    noticeSequence: pending?.noticeSequence || null,
    pendingNotice: pending ? { noticeSequence: pending.noticeSequence, turnId: pending.turnId, outcome: pending.outcome } : null,
    acknowledgedThrough: row.acknowledgedThrough,
    // Generation certainty does not determine whether an existing tab can be
    // visited. The extension still checks the exact tab/document/route twice.
    canFocus: activeRuns.get(row.clientId) === row.browserRunId && observation !== "closed",
    capabilities: { focus: true, acknowledge: true, dismiss: true, directSend: false, permission: false },
    lastConnectionAt: connectionTimes.get(row.clientId) || 0,
    lastObservationAt: row.lastObservationAt, phaseChangedAt: row.phaseChangedAt,
    turnStartedAt: row.turnStartedAt, updatedAt: row.phaseChangedAt, createdAt: row.createdAt,
  };
}

function createBrowserSessionStore({ dataDir, now = Date.now, fs, onChange = () => {}, onNotice = () => {} } = {}) {
  const file = openJsonFile(path.join(dataDir, "sessions.json"), validateStore, fs ? { fs } : {});
  let data = file.value || { version: VERSION, sessions: [], receipts: [], nextNoticeSequence: 0, labels: { chatgpt: 0, claude: 0 } };
  const activeRuns = new Map();
  const connectionTimes = new Map();
  const restored = new Set(data.sessions.map((row) => row.id));
  let lastProjectionSignature = "";
  let lastError = null;
  let lastNoticeAt = -Infinity;

  function rows() {
    return data.sessions.filter((row) => !row.dismissed).map((row) => projectRow(data, row, now(), activeRuns, restored, connectionTimes))
      .sort((a, b) => {
        const priority = (row) => row.requiresCompletionAck || row.status === "error" ? 3 : row.status === "generating" ? 2 : 1;
        return priority(b) - priority(a) || b.phaseChangedAt - a.phaseChangedAt || a.createdAt - b.createdAt;
      });
  }
  function changed() {
    const snapshot = rows();
    // Transport heartbeats never produce desktop activity or reorder rows.
    const signature = JSON.stringify({ recentNotice: now() - lastNoticeAt < 5000,
      rows: snapshot.map(({ lastConnectionAt: _connection, ...row }) => row) });
    if (signature !== lastProjectionSignature) {
      lastProjectionSignature = signature;
      try { onChange(snapshot); } catch { /* Presentation failures cannot undo a durable receipt. */ }
    }
  }
  function commit(next) {
    try { file.write(next); } catch (error) { lastError = "session_store_write_failed"; throw protocolError(lastError, error.message); }
    data = next;
    lastError = null;
  }
  function getRecord(id) { return data.sessions.find((row) => row.id === id); }

  return {
    connect(clientId, browserRunId) {
      if (!isId(clientId) || !isId(browserRunId)) throw protocolError("invalid_client");
      for (const row of data.sessions) if (row.clientId === clientId) restored.add(row.id);
      activeRuns.set(clientId, browserRunId); connectionTimes.set(clientId, now()); changed();
    },
    heartbeat(clientId) { if (activeRuns.has(clientId)) connectionTimes.set(clientId, now()); },
    disconnect(clientId, browserRunId) {
      if (activeRuns.get(clientId) === browserRunId) { activeRuns.delete(clientId); changed(); }
    },
    ingest(clientId, input) {
      const event = validateEvent(input);
      if (!isId(clientId)) throw protocolError("invalid_client");
      const currentRun = activeRuns.get(clientId) === event.browserRunId;
      if (!currentRun && !(["terminal", "closed"].includes(event.kind) && event.replay)) throw protocolError("stale_browser_run");
      if (event.observedAt > now() + 30 * 1000) throw protocolError("invalid_observed_time");
      const id = desktopSessionId(clientId, event.browserRunId, event.sessionId);
      const receiptKey = `${id}:${event.eventId}`;
      const existingReceipt = data.receipts.find((receipt) => receipt.key === receiptKey);
      if (existingReceipt) {
        if (existingReceipt.fingerprint !== eventFingerprint(event)) throw protocolError("event_id_conflict");
        return { duplicate: true, id, eventId: event.eventId, sequence: event.sequence };
      }
      const existing = getRecord(id);
      if (existing && (existing.provider !== event.provider || existing.tabId !== event.tabId)) throw protocolError("session_identity_conflict");
      const fresh = !event.replay && currentRun && event.observation === "fresh" && now() - event.observedAt <= STALE_MS;
      if (!existing && data.sessions.length >= MAX_SESSIONS) throw protocolError("session_limit");
      if (fresh && (!existing || existing.dismissed || effectiveObservation(existing, now(), activeRuns, restored) !== "fresh")) {
        const activeCount = data.sessions.filter((row) => !row.dismissed && effectiveObservation(row, now(), activeRuns, restored) === "fresh").length;
        if (activeCount >= MAX_ACTIVE) throw protocolError("active_session_limit");
      }
      if (event.kind === "terminal" && data.receipts.length >= MAX_RECEIPTS) throw protocolError("receipt_limit");
      const next = structuredClone(data);
      let row = next.sessions.find((item) => item.id === id);
      if (!row) {
        const labelNumber = ++next.labels[event.provider];
        row = {
          id, clientId, browserRunId: event.browserRunId, sessionId: event.sessionId,
          provider: event.provider, label: `${event.provider === "chatgpt" ? "ChatGPT" : "Claude"} ${labelNumber}`,
          tabId: event.tabId, pageInstanceId: event.pageInstanceId, routeRevision: event.routeRevision,
          conversationRef: event.conversationRef, currentTurnId: null, generation: 0, lastSequence: 0,
          phase: "idle", outcome: null, observation: "stale", lastObservationAt: 0,
          phaseChangedAt: event.observedAt, turnStartedAt: null, createdAt: now(), acknowledgedThrough: 0, dismissed: false,
        };
        next.sessions.push(row);
      }
      // Receipt acceptance is deliberately independent of live-state ordering.
      let notice = null;
      if (event.kind === "terminal") {
        notice = {
          key: receiptKey, id, eventId: event.eventId, fingerprint: eventFingerprint(event),
          noticeSequence: ++next.nextNoticeSequence, turnId: event.turnId,
          generation: event.generation, outcome: event.outcome, observedAt: event.observedAt,
        };
        next.receipts.push(notice);
        row.dismissed = false;
      }
      let liveChanged = false;
      const newer = event.sequence > row.lastSequence && event.generation >= row.generation
        && event.routeRevision >= row.routeRevision;
      if (newer && event.kind === "observation" && event.replay && currentRun && existing
        && ["stale", "unsupported"].includes(event.observation)) {
        // Replayed metadata can invalidate old DOM evidence, never make it live.
        row.lastSequence = event.sequence;
        row.routeRevision = event.routeRevision;
        row.observation = event.observation;
        liveChanged = true;
      } else if (newer && event.kind === "closed" && event.replay && existing) {
        // Offline tab closure is a durable history update for its original row only.
        // It must not replace a known completion with a stale phase from the outbox.
        row.lastSequence = event.sequence;
        row.observation = "closed";
        liveChanged = true;
      } else if (newer && ((!event.replay && currentRun) || !existing)) {
        const phaseChanged = row.phase !== event.phase || row.currentTurnId !== event.turnId || row.outcome !== event.outcome;
        const newTurn = event.generation > row.generation;
        row.lastSequence = event.sequence;
        row.pageInstanceId = event.pageInstanceId;
        row.routeRevision = event.routeRevision;
        row.conversationRef = event.conversationRef;
        row.currentTurnId = event.turnId;
        row.generation = event.generation;
        row.phase = event.phase;
        row.outcome = event.outcome;
        row.observation = event.observation === "fresh" && !fresh ? "stale" : event.observation;
        if (fresh) row.lastObservationAt = event.observedAt;
        if (phaseChanged) row.phaseChangedAt = event.observedAt;
        if (newTurn && event.phase === "running") { row.turnStartedAt = event.observedAt; row.dismissed = false; }
        liveChanged = true;
      }
      if (!notice && !liveChanged) return { duplicate: true, id, eventId: event.eventId, sequence: event.sequence };
      commit(next); // The server is allowed to send event.ack only after this succeeds.
      if (fresh && liveChanged) restored.delete(id);
      if (notice) lastNoticeAt = now();
      changed();
      if (notice) {
        try { onNotice({ ...notice, session: rows().find((item) => item.id === id), replay: event.replay }); }
        catch { /* The unread receipt remains available if a notification surface is unavailable. */ }
      }
      return { duplicate: false, id, eventId: event.eventId, sequence: event.sequence };
    },
    getSnapshot: rows,
    getFocusTarget(id, noticeSequence) {
      const row = rows().find((item) => item.id === id);
      if (!row || !row.canFocus) return null;
      const captured = noticeSequence === undefined ? row.noticeSequence : noticeSequence;
      if (captured !== null && (!isInteger(captured, 1) || !data.receipts.some((receipt) => receipt.id === id && receipt.noticeSequence === captured))) return null;
      return { ...row, noticeSequence: captured };
    },
    matchesFocusTarget(target) {
      const current = rows().find((item) => item.id === target.id);
      return !!current?.canFocus && ["clientId", "browserRunId", "sessionId", "tabId", "pageInstanceId", "routeRevision", "conversationRef"]
        .every((key) => current[key] === target[key]);
    },
    ack(id, noticeSequence) {
      const existing = getRecord(id);
      if (!existing) return { ok: false, reason: "session_missing" };
      const pending = pendingReceipts(data, existing);
      const captured = noticeSequence === undefined ? pending.at(-1)?.noticeSequence : noticeSequence;
      if (captured === null || captured === undefined) return { ok: true };
      if (!isInteger(captured, 1) || !data.receipts.some((receipt) => receipt.id === id && receipt.noticeSequence === captured)) return { ok: false, reason: "notice_missing" };
      if (captured <= existing.acknowledgedThrough) return { ok: true };
      const next = structuredClone(data);
      next.sessions.find((row) => row.id === id).acknowledgedThrough = captured;
      commit(next); changed();
      return { ok: true };
    },
    dismiss(id) {
      const existing = getRecord(id);
      if (!existing) return { ok: false, reason: "session_missing" };
      const next = structuredClone(data);
      const row = next.sessions.find((item) => item.id === id);
      row.acknowledgedThrough = Math.max(row.acknowledgedThrough, ...next.receipts.filter((receipt) => receipt.id === id).map((receipt) => receipt.noticeSequence));
      row.dismissed = true;
      commit(next); changed();
      return { ok: true };
    },
    setLabel(id, input) {
      // Explicit local display metadata only. Never accept this through a
      // browser event or send it back to the extension / external consumers.
      if (typeof input !== "string" || input.length > MAX_CUSTOM_LABEL_LENGTH
        || /[\u0000-\u001f\u007f-\u009f]/.test(input)) return { ok: false, reason: "invalid_label" };
      const customLabel = input.trim();
      const existing = getRecord(id);
      if (!existing || existing.dismissed) return { ok: false, reason: "session_missing" };
      if ((existing.customLabel || "") === customLabel) return { ok: true };
      const next = structuredClone(data);
      const row = next.sessions.find((item) => item.id === id);
      if (customLabel) row.customLabel = customLabel;
      else delete row.customLabel;
      commit(next); changed();
      return { ok: true };
    },
    forgetClient(clientId) {
      // Only call after the corresponding authentication credential is revoked.
      const ids = new Set(data.sessions.filter((row) => row.clientId === clientId).map((row) => row.id));
      const next = { ...data, sessions: data.sessions.filter((row) => !ids.has(row.id)), receipts: data.receipts.filter((receipt) => !ids.has(receipt.id)) };
      commit(next); activeRuns.delete(clientId); connectionTimes.delete(clientId); changed();
    },
    tick: changed,
    getStatus() { return { error: lastError, recovery: file.recovery, sessions: data.sessions.length, receipts: data.receipts.length, limits: { active: MAX_ACTIVE, sessions: MAX_SESSIONS, receipts: MAX_RECEIPTS } }; },
    getVisualState() {
      const snapshot = rows();
      if (now() - lastNoticeAt < 5000 && snapshot.some((row) => row.requiresCompletionAck)) return "attention";
      if (snapshot.some((row) => row.status === "generating")) return "working";
      return "idle";
    },
  };
}

module.exports = { createBrowserSessionStore, STALE_MS, MAX_ACTIVE, MAX_SESSIONS, MAX_RECEIPTS, MAX_CUSTOM_LABEL_LENGTH, validateStore };
