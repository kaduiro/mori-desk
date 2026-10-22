"use strict";
const $ = id => document.getElementById(id);
const feedback = text => { $("status").textContent = text; };
let refreshing = false;
let dirty = false;
const pending = new Set();
const sessionViews = new Map();
let lastSelectionRevision = null;
const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function noticeSequence(row) { return row.pendingNotice?.noticeSequence ?? row.noticeSequence ?? null; }
function isHistory(row) { return row.isHistory === true || row.isCurrent === false; }
function isEditing(view) { return view.input === document.activeElement || view.composing; }
function unreadCount(row) { return Number.isSafeInteger(row.unreadCount) ? Math.max(0, row.unreadCount) : (row.pendingNotice || row.requiresCompletionAck ? 1 : 0); }
function statusLabel(row) {
  if (row.statusLabel) return row.statusLabel;
  if (row.observation === "closed") return "タブを閉じました";
  if (row.observation === "stale") return "状態を確認できません";
  if (row.observation === "unsupported") return "この画面は未対応";
  if (row.phase === "running") return "生成中";
  return ({ completed: "回答完了", interrupted: "中断", error: "エラー", unverified: "回答を確認" })[row.outcome] || "待機中";
}
async function act(key, button, fn, success) {
  if (pending.has(key)) return;
  pending.add(key); button.disabled = true;
  try { const result = await fn(); feedback(result?.ok || result?.status === "ok" ? success : result?.message || `操作できませんでした（${result?.reason || "unknown"}）。未読は保持されます。`); }
  catch { feedback("操作に失敗しました。接続状態を確認してください。"); }
  finally { pending.delete(key); button.disabled = false; refresh(); }
}
function actionButton(text, row, kind, fn, success) {
  const button = document.createElement("button"); button.textContent = text;
  const key = `${row.id}/${kind}`; button.disabled = pending.has(key);
  button.addEventListener("click", () => act(key, button, fn, success)); return button;
}

function observedTime(value, fallback = "未取得") {
  const date = new Date(value);
  return Number.isFinite(value) && value > 0 && Number.isFinite(date.getTime()) ? timeFormatter.format(date) : fallback;
}

function lastObservedState(row) {
  if (row.phase === "running") return "生成中";
  if (row.phase === "settled") return ({ completed: "回答完了", interrupted: "生成を中断", error: "エラー", unverified: "回答を確認" })[row.outcome] || "生成後の状態";
  return row.lastObservationAt ? "待機中" : "未取得";
}

function createSessionView(row) {
  const card = document.createElement("article"); card.className = "session";
  const top = document.createElement("div"); top.className = "session-top";
  const heading = document.createElement("div"); heading.className = "session-heading";
  const name = document.createElement("h3"); name.className = "session-name";
  const sourceName = document.createElement("span"); sourceName.className = "session-source";
  heading.append(name, sourceName);
  const state = document.createElement("span"); state.className = "session-state";
  const unread = document.createElement("span"); unread.className = "session-unread";
  top.append(heading, state, unread);
  const detail = document.createElement("p"); detail.className = "session-detail";
  const preview = document.createElement("p"); preview.className = "session-request-preview";
  const recovery = document.createElement("p"); recovery.className = "session-recovery";
  const metadata = document.createElement("dl"); metadata.className = "session-metadata";
  const fields = new Map();
  for (const [key, label] of [
    ["lastState", "最後に観測した状態"], ["generation", "検知した生成回数"],
    ["started", "生成開始の観測時刻"], ["changed", "状態が変わった時刻"],
    ["observed", "最後に状態を確認できた時刻"], ["connected", "ブラウザとの最終通信"],
    ["unread", "未確認の通知"],
  ]) {
    const item = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const value = document.createElement("dd"); fields.set(key, value);
    item.append(term, value); metadata.append(item);
  }
  const actions = document.createElement("div"); actions.className = "session-actions";
  const view = { row, card, name, sourceName, state, unread, detail, preview, recovery, fields, draftDirty: false, composing: false, savedLabel: "" };
  view.focusButton = actionButton("タブへ戻る", row, "focus", () => {
    const current = view.row;
    if (current.canFocus !== true) return { ok: false, message: current.focusUnavailableReason || "このタブへ戻れる接続がありません。" };
    return window.mori.focus(current.id, noticeSequence(current));
  }, "元のタブを開きました。");
  view.ackButton = actionButton("確認済みにする", row, "ack", () => window.mori.ack(view.row.id, noticeSequence(view.row)), "確認済みにしました。");
  view.dismissButton = actionButton("一覧から削除", row, "dismiss", () => window.mori.dismiss(view.row.id), "一覧から削除しました。");
  actions.append(view.focusButton, view.ackButton, view.dismissButton);
  view.navigationHint = document.createElement("p"); view.navigationHint.className = "session-navigation-hint";

  const editor = document.createElement("form"); editor.className = "session-label-editor";
  const label = document.createElement("label"); label.className = "session-label-field";
  const labelText = document.createElement("span"); labelText.textContent = "この PC だけの表示名";
  const input = document.createElement("input"); input.className = "session-label-input";
  input.type = "text"; input.maxLength = 80; input.autocomplete = "off"; input.spellcheck = false;
  input.placeholder = "例：議事録の整理（80 文字以内）";
  input.addEventListener("input", () => { view.draftDirty = input.value !== view.savedLabel; });
  input.addEventListener("compositionstart", () => { view.composing = true; });
  input.addEventListener("compositionend", () => { view.composing = false; view.draftDirty = input.value !== view.savedLabel; refresh(); });
  input.addEventListener("blur", () => { if (!view.composing) refresh(); });
  label.append(labelText, input); view.input = input;
  const saveButton = document.createElement("button"); saveButton.type = "submit"; saveButton.textContent = "表示名を保存";
  view.saveButton = saveButton;
  editor.addEventListener("submit", event => {
    event.preventDefault();
    if (view.composing) return;
    const draft = input.value;
    act(`${view.row.id}/label`, saveButton, async () => {
      const result = await window.mori.setLabel(view.row.id, draft);
      // A slow save must not replace text typed after the user pressed Save.
      if (result?.ok && input.value === draft) view.draftDirty = false;
      return result;
    }, "表示名を保存しました。");
  });
  editor.append(label, saveButton);
  const editorHint = document.createElement("p"); editorHint.className = "session-label-hint";
  editorHint.textContent = "入力した表示名を優先します。空欄で保存すると会話名に戻り、未取得の場合はサービス名と番号を表示します。";
  card.append(top, preview, detail, recovery, metadata, actions, view.navigationHint, editor, editorHint);
  return view;
}

function updateSessionView(view, row) {
  view.row = row;
  view.name.textContent = row.displayTitle || row.label || row.provider || "ブラウザ";
  view.sourceName.textContent = [row.label || row.provider || "ブラウザ",
    row.conversationTitle ? (row.customLabel ? `会話名：${row.conversationTitle}` : "") : "会話名は未取得"].filter(Boolean).join(" · ");
  view.sourceName.hidden = false;
  view.preview.textContent = row.requestPreview ? `直近の依頼：${row.requestPreview}` : "直近の依頼は未取得です。";
  view.preview.classList.toggle("preview-unavailable", !row.requestPreview);
  view.state.textContent = statusLabel(row);
  view.card.dataset.status = row.status || "unknown";
  view.card.dataset.history = String(isHistory(row));
  view.detail.textContent = row.statusDetail || "現在の状態は、タブへ戻って確認してください。";
  view.recovery.textContent = row.recoveryHint || ""; view.recovery.hidden = !row.recoveryHint;
  const unread = unreadCount(row);
  view.unread.textContent = `未確認 ${unread} 件`; view.unread.hidden = unread === 0;
  view.fields.get("lastState").textContent = lastObservedState(row);
  view.fields.get("generation").textContent = Number.isSafeInteger(row.generation) ? `${row.generation} 回` : "未取得";
  view.fields.get("started").textContent = observedTime(row.turnStartedAt);
  view.fields.get("changed").textContent = observedTime(row.phaseChangedAt);
  view.fields.get("observed").textContent = observedTime(row.lastObservationAt, "未受信");
  view.fields.get("connected").textContent = observedTime(row.lastConnectionAt, "この起動では未接続");
  view.fields.get("unread").textContent = `${unread} 件`;
  view.focusButton.disabled = pending.has(`${row.id}/focus`) || row.canFocus !== true;
  view.focusButton.title = row.canFocus === true ? "この記録に対応する Chrome のタブを確認して開きます。" : row.focusUnavailableReason || "このタブへ戻れる接続がありません。";
  view.ackButton.hidden = !(row.requiresCompletionAck || row.pendingNotice);
  view.ackButton.disabled = pending.has(`${row.id}/ack`);
  view.dismissButton.hidden = !(row.observation === "closed" || row.observation === "stale");
  view.dismissButton.disabled = pending.has(`${row.id}/dismiss`);
  view.navigationHint.hidden = row.canFocus === true;
  view.navigationHint.textContent = row.canFocus === true ? "" : row.focusUnavailableReason || "このタブへ戻れる接続がありません。上の案内を確認してください。";
  view.savedLabel = row.customLabel || "";
  if (!view.draftDirty && !view.composing) view.input.value = view.savedLabel;
  else if (view.input.value === view.savedLabel) view.draftDirty = false;
  view.saveButton.disabled = pending.has(`${row.id}/label`);
}

function renderSessions(rows, selectedSessionId, selectionRevision) {
  const container = $("sessions");
  const historyContainer = $("history-sessions");
  const ids = new Set(rows.map(row => row.id));
  for (const [id, view] of sessionViews) {
    if (!ids.has(id)) { view.card.remove(); sessionViews.delete(id); }
  }
  const editing = Array.from(sessionViews.values()).some(isEditing);
  for (const row of rows) {
    let view = sessionViews.get(row.id);
    if (!view) {
      view = createSessionView(row); sessionViews.set(row.id, view);
      (isHistory(row) ? historyContainer : container).append(view.card);
    }
    updateSessionView(view, row);
    view.card.classList.toggle("session-selected", row.id === selectedSessionId);
    // Only the active editor needs to stay in its old group. Another row's
    // reconnect/disconnect must not be delayed by this input's composition.
    const target = isHistory(row) ? historyContainer : container;
    if (!isEditing(view) && view.card.parentNode !== target) target.append(view.card);
  }
  // Moving a focused input may interrupt IME composition. Keep its DOM position
  // until the next non-editing refresh; new sessions can still be appended.
  if (!editing) for (const [target, subset] of [
    [container, rows.filter(row => !isHistory(row))], [historyContainer, rows.filter(isHistory)],
  ]) subset.forEach((row, index) => {
    const card = sessionViews.get(row.id).card;
    if (target.children[index] !== card) target.insertBefore(card, target.children[index] || null);
  });
  // A row can already be current in the snapshot while its focused editor is
  // still inside history. Hide the group only after its actual cards moved.
  $("history").hidden = historyContainer.children.length === 0;
  if (Number.isSafeInteger(selectionRevision) && selectionRevision !== lastSelectionRevision) {
    lastSelectionRevision = selectionRevision;
    const selected = sessionViews.get(selectedSessionId);
    if (selected?.card.parentNode === historyContainer) $("history").open = true;
    if (selected) selected.card.scrollIntoView({ block: "start", behavior: "instant" });
  }
  return { visibleCurrentCount: container.children.length,
    heldCurrentCount: rows.filter(row => !isHistory(row)
      && sessionViews.get(row.id).card.parentNode === historyContainer).length };
}
async function refresh() {
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  try {
    const value = await window.mori.status();
    const rows = value.sessions || [];
    const connected = value.bridge?.connectedClients || [];
    const connection = value.connection || {};
    $("pair").disabled = !connection.canPair;
    $("connection").textContent = connection.label || "接続準備中";
    $("connection").dataset.state = connection.state || "starting";
    $("connection-detail").textContent = connection.detail || "";
    $("server-detail").textContent = value.port ? "この PC の接続先は準備できています。" : "";
    for (const provider of ["chatgpt", "claude"]) {
      const item = connection.providers?.find(row => row.provider === provider);
      $(`${provider}-status`).textContent = item?.label || "確認状況は未受信";
      $(`${provider}-status`).dataset.state = item?.state || "unknown";
      $(`${provider}-detail`).textContent = item?.detail || "ブラウザからの詳細状態を待っています。";
    }
    $("delivery-status").textContent = connection.delivery?.label || "保存済み通知の同期状況は未確認";
    $("login-status").textContent = connection.login?.label || "ログイン時の自動起動：登録状態は未確認";
    $("version-status").textContent = [
      `Mori Desk：${connection.desktopVersion || "未確認"}`,
      ...(connection.versions || []).map(item => `${item.label}：拡張 ${item.extensionVersion || "未確認"} / 同梱の監視プログラム ${item.observerVersion || "未確認"}（${item.compatibility}）`),
      "ページで実行中の監視プログラムの版は、この表示では確認していません。",
    ].join("\n");
    $("mode").textContent = value.cliEnabled ? "CLI 連携モード：有効。CLI セッションはキャラクター下の HUD に一緒に表示されます。" : "ブラウザ用モード。CLI の自動セットアップは無効です。";
    if (value.error || value.bridge?.error) {
      const errors = { secure_storage_unavailable: "OS の保護された鍵の保存先を利用できないため、ペアリングは停止しています。Windows / Mac で確認してください。",
        session_limit: "保存できるセッション数の上限です。保存済みの記録と未確認通知は保持しています。履歴の整理には後続版の保存容量対応が必要です。",
        active_session_limit: "同時に観測できるセッション数の上限です。対象タブを減らしてください。",
        receipt_limit: "保存できる通知数の上限です。保存済みの通知は保持しています。履歴の整理には後続版の保存容量対応が必要です。" };
      feedback(value.error || errors[value.bridge.error] || `接続状態: ${value.bridge.error}`);
    }
    $("profiles").replaceChildren();
    for (const [index, profile] of (value.bridge?.pairedClients || []).entries()) {
      const line = document.createElement("div"); line.className = "session-actions";
      const label = document.createElement("span"); label.className = "session-state";
      label.textContent = `ブラウザ ${index + 1} · ${connected.some(client => client.clientId === profile.clientId) ? "接続中" : "未接続"}`;
      const button = actionButton("接続と履歴を解除", { id: profile.clientId }, "revoke", () => window.mori.revoke(profile.clientId), "接続とブラウザの履歴を解除しました。再利用にはペアリングしてください。");
      line.append(label, button); $("profiles").append(line);
    }
    const currentRows = rows.filter(row => !isHistory(row));
    const historyRows = rows.filter(isHistory);
    const historyUnread = historyRows.reduce((sum, row) => sum + unreadCount(row), 0);
    const placement = renderSessions(rows, value.selectedSessionId, value.selectionRevision);
    $("count").textContent = `${currentRows.length} 件`;
    $("empty").hidden = placement.visibleCurrentCount > 0;
    $("empty").textContent = placement.heldCurrentCount ? "再接続したタブの表示名は、下の一覧で編集を続けられます。"
      : historyRows.length ? "現在のタブはありません。以前の記録と未確認通知は下の一覧から確認できます。" : connection.emptyText || "生成状態を待っています。";
    $("history-count").textContent = `${historyRows.length} 件${placement.heldCurrentCount ? ` · 再接続した ${placement.heldCurrentCount} 件を編集中` : ""}`;
    $("history-unread").textContent = `未確認 ${historyUnread} 件`;
    $("history-unread").hidden = historyUnread === 0;
  } catch { feedback("アプリの状態を読み込めませんでした。接続画面を開き直してください。"); }
  finally { refreshing = false; if (dirty) { dirty = false; refresh(); } }
}
$("pair").addEventListener("click", async () => {
  try { const result = await window.mori.pair(); if (!result.ok) { feedback(result.message || "接続コードを作成できません。"); return; }
    $("code").value = result.code; $("pairing").hidden = false; feedback("2 分以内に拡張機能の設定画面へ貼り付けてください。");
  } catch { feedback("接続コードを作成できません。"); }
});
$("copy").addEventListener("click", () => act("copy", $("copy"), () => window.mori.copy(), "コードをコピーしました。"));
$("extension").addEventListener("click", () => act("extension", $("extension"), () => window.mori.openExtension(), "開いた browser-bridge フォルダーを Chrome で選択してください。"));
window.mori.onChange(refresh);
refresh();
