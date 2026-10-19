"use strict";
const $ = id => document.getElementById(id);
const feedback = text => { $("status").textContent = text; };
let refreshing = false;
let dirty = false;
const pending = new Set();

function noticeSequence(row) { return row.pendingNotice?.noticeSequence ?? row.noticeSequence ?? null; }
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
async function refresh() {
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  try {
    const value = await window.mori.status();
    const rows = value.sessions || [];
    const connected = value.bridge?.connectedClients || [];
    const pairingAvailable = value.bridge?.pairingAvailable === true;
    $("pair").disabled = !pairingAvailable || !value.port;
    $("connection").textContent = connected.length ? `${connected.length} ブラウザ接続中` : !pairingAvailable ? "接続を確認" : value.port ? "接続受付中" : "接続準備中";
    $("mode").textContent = value.cliEnabled ? "CLI 連携モード：有効。CLI セッションはキャラクター下の HUD に一緒に表示されます。" : "ブラウザ用モード。CLI の自動セットアップは無効です。";
    if (value.error || value.bridge?.error) {
      const errors = { secure_storage_unavailable: "OS の保護された鍵の保存先を利用できないため、ペアリングは停止しています。Windows / Mac で確認してください。",
        session_limit: "保存できるセッション数の上限です。接続を解除して履歴を削除するか、後続版の保存容量対応が必要です。",
        active_session_limit: "同時に観測できるセッション数の上限です。対象タブを減らしてください。",
        receipt_limit: "保存できる通知数の上限です。接続を解除して履歴を削除するか、後続版の履歴整理対応が必要です。" };
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
    $("count").textContent = `${rows.length} 件`;
    $("empty").hidden = rows.length > 0;
    $("sessions").replaceChildren();
    for (const row of rows) {
      const card = document.createElement("article"); card.className = "session";
      const top = document.createElement("div"); top.className = "session-top";
      const name = document.createElement("span"); name.className = "session-name"; name.textContent = row.displayTitle || row.label || row.provider || "ブラウザ";
      const state = document.createElement("span"); state.className = "session-state"; state.textContent = statusLabel(row); top.append(name, state); card.append(top);
      const seq = noticeSequence(row);
      const actions = document.createElement("div"); actions.className = "session-actions";
      const focusButton = actionButton("タブへ戻る", row, "focus", () => window.mori.focus(row.id, seq), "タブを開きました。");
      focusButton.disabled ||= row.canFocus !== true;
      actions.append(focusButton);
      if (row.requiresCompletionAck || row.pendingNotice) {
        const unread = document.createElement("span"); unread.className = "session-unread"; unread.textContent = "未確認"; top.append(unread);
        actions.append(actionButton("確認済みにする", row, "ack", () => window.mori.ack(row.id, seq), "確認済みにしました。"));
      }
      if (row.observation === "closed" || row.observation === "stale") actions.append(actionButton("一覧から削除", row, "dismiss", () => window.mori.dismiss(row.id), "一覧から削除しました。"));
      card.append(actions); $("sessions").append(card);
    }
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
