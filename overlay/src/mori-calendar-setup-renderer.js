"use strict";
const $ = id => document.getElementById(id);
let state = null;
let draft = null;
let busy = false;
let message = "";
let showSelection = false;
const format = value => value && value > Date.now()
  ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "今すぐ可能";
const linked = value => !["config-needed", "unlinked", "auth-failed", "auth-expired", "config-changed",
  "secure-storage-unavailable", "storage-error"].includes(value.status);
function stepFor(data) {
  if (!data.configSource || data.reason === "calendar-client-config-invalid") return 0;
  if (!linked(data)) return 1;
  if (!data.selectionConfirmed || showSelection) return 2;
  return 3;
}
function statusText(data) {
  if (message) return message;
  const reasons = {
    "config-needed": "組織の設定がありません。管理者から受け取った Desktop OAuth 設定を選んでください。",
    "storage-error": data.reason === "calendar-client-config-invalid"
      ? "設定ファイルを読み取れません。管理者から受け取った Desktop OAuth 設定を選び直してください。"
      : "予定の保存領域を確認できません。PC の管理者に相談してください。",
    "secure-storage-unavailable": "この PC では認証情報を安全に保存できません。PC の管理者に相談してください。",
    unlinked: "設定を確認しました。Google Calendar に接続してください。",
    authorizing: "ブラウザで本人の同意を完了してください。",
    "auth-failed": data.reason === "auth-timeout" ? "同意が時間切れになりました。もう一度接続してください。"
      : data.reason === "client-secret-required" ? "OAuth 設定が不足しています。管理者へ連絡してください。"
      : "Google への接続が完了しませんでした。再試行するか、管理者へ相談してください。",
    "config-changed": "接続設定が変わりました。新しい設定で Google に再同意してください。",
    "auth-expired": "Google との連携が失効しました。再接続してください。",
    "quota-paused": "Google の利用枠により取得を停止しています。",
    "local-limit": "この PC の24時間の取得上限に達しました。",
    partial: "一部のカレンダーは取得できませんでした。",
    failed: "予定を取得できませんでした。最終取得時刻と選択内容を確認してください。",
  };
  return reasons[data.status] || (stepFor(data) === 2
    ? "表示するカレンダーを確認し、適用してください。" : "設定が完了しました。");
}
function renderOptions(data) {
  if (!draft) draft = new Set(data.selectedIds || ["primary"]);
  const choices = data.calendars?.length ? data.calendars : [{ id: "primary", name: "メイン", readable: true }];
  const rows = choices.map(item => {
    const label = document.createElement("label"); label.className = "option";
    if (!item.readable) label.classList.add("unreadable");
    const box = document.createElement("input"); box.type = "checkbox";
    box.checked = draft.has(item.id); box.disabled = !item.readable || busy;
    box.addEventListener("change", () => {
      if (box.checked && draft.size >= 3) { box.checked = false;
        message = "最大3件です。別のカレンダーを選ぶには、選択済みのチェックを1つ外してください。";
      } else { if (box.checked) draft.add(item.id); else draft.delete(item.id); message = ""; }
      updateSelectionNote(data);
    });
    const name = document.createElement("span"); name.textContent = item.name;
    label.append(box, name); return label;
  });
  for (const id of draft) {
    if (choices.some(item => item.id === id)) continue;
    const label = document.createElement("label"); label.className = "option unreadable";
    const box = document.createElement("input"); box.type = "checkbox"; box.checked = true;
    box.addEventListener("change", () => { if (!box.checked) draft.delete(id); updateSelectionNote(data); });
    const name = document.createElement("span"); name.textContent = "取得不可: " + id.slice(0, 80);
    label.append(box, name); rows.push(label);
  }
  $("calendar-options").replaceChildren(...rows);
  updateSelectionNote(data);
}
function updateSelectionNote(data) {
  const suffix = data.listScope ? "" : " カレンダー一覧の権限がありません。再同意してください。";
  const listWait = data.listStatus === "waiting" && data.listNextAt
    ? ` 候補一覧の次回更新: ${format(data.listNextAt)}。` : "";
  $("selection-description").textContent = `選択中: ${draft.size}/3。${message || "最大3件まで選べます。0件なら予定取得を停止します。"}${suffix}${listWait}`;
  $("apply-selection").disabled = busy || draft.size > 3;
}
function render(data) {
  state = data;
  const step = stepFor(data);
  for (const [index, node] of [...$("steps").children].entries()) {
    node.className = index < step ? "done" : index === step ? "active" : "";
  }
  $("message").textContent = statusText(data);
  $("config-panel").hidden = step !== 0;
  $("connect-panel").hidden = step !== 1;
  $("selection-panel").hidden = step !== 2;
  $("result-panel").hidden = step !== 3;
  $("config-description").textContent = data.configSource === "managed"
    ? "組織の設定を読み込みました。" : "設定ファイルを選ぶと、Mori Desk の専用領域に保存します。";
  $("connect-description").textContent = data.status === "config-changed"
    ? "以前の接続は新しい設定には利用しません。ブラウザで再同意してください。"
    : "予定と登録済みカレンダー一覧の読み取りに同意します。";
  $("connect").disabled = busy || ["authorizing", "secure-storage-unavailable", "storage-error"].includes(data.status);
  $("config-source").textContent = data.configSource === "managed" ? "組織の配布設定"
    : data.configSource === "personal" ? "この PC の設定" : "未設定";
  $("selected-count").textContent = `${data.selectedIds?.length || 0} / 3 件`;
  $("last-fetch").textContent = data.fetchedAt
    ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "short" }).format(new Date(data.fetchedAt)) : "未取得";
  $("next-refresh").textContent = data.nextManualAt ? format(data.nextManualAt) : "未取得";
  $("request-count").textContent = Number.isInteger(data.requestCount)
    ? `${data.requestCount} / ${data.requestLimit} 回（直近24時間）` : "確認できません";
  $("source-statuses").textContent = (data.sources || []).map(item =>
    `${item.name}: ${({ success: "取得済み", cached: "以前の取得結果", missing: "未取得",
      "permission-denied": "権限不足", "calendar-not-found": "アクセス不可",
      "local-limit": "取得上限", "google-quota": "利用枠停止" })[item.status] || "取得失敗"}`)
    .join(" / ");
  $("disconnect").hidden = !linked(data) && !["auth-expired", "config-changed"].includes(data.status);
  $("disconnect").disabled = busy;
  $("switch-config").disabled = busy;
  $("use-managed").hidden = !data.managedDiffers;
  $("use-managed").disabled = busy;
  if (step === 2) renderOptions(data);
  $("reload-calendars").disabled = busy || !data.listScope;
  $("grant-scope").hidden = !!data.listScope;
  $("grant-scope").disabled = busy;
  if (step === 3) {
    $("result-description").textContent = data.status === "ready"
      ? `${data.selectedIds.length}件のカレンダーを選択しました。今日の予定は ${data.events.length} 件です。`
      : `${data.selectedIds.length}件のカレンダーを選択しました。${statusText(data)}`;
  }
}
async function refresh() {
  try { const result = await window.moriCalendarSetup.state(); if (result.ok) render(result); }
  catch { $("message").textContent = "状態を読み取れません。"; }
}
async function action(fn) {
  if (busy) return;
  busy = true; message = "";
  try {
    const result = await fn();
    if (!result?.ok && result?.reason !== "cancelled") {
      message = ({ "disconnect-first": "設定を切り替えるには、先に Google 連携を解除してください。",
        "not-desktop-client": "デスクトップ アプリ用の JSON を選んでください。",
        "invalid-desktop-client": "Desktop OAuth の ID とシークレットを確認してください。",
        "invalid-json": "JSON ファイルを読み取れません。",
        "invalid-config-file": "設定ファイルの形式またはサイズを確認してください。",
        "managed-config-unavailable": "組織の配布設定がありません。管理者に確認してください。",
        "managed-switch-failed": "組織の配布設定へ切り替えられませんでした。設定を確認してください。",
        "config-restore-failed": "元の設定を復元できませんでした。PC の管理者に相談してください。",
        "invalid-selection": "選択内容を確認してください。" })[result?.reason] || "操作を完了できませんでした。";
    }
  } catch { message = "操作を完了できませんでした。"; }
  finally { busy = false; await refresh(); }
}
$("import-config").addEventListener("click", () => action(() => window.moriCalendarSetup.importConfig()));
$("switch-config").addEventListener("click", () => action(() => window.moriCalendarSetup.importConfig()));
$("use-managed").addEventListener("click", () => {
  if (window.confirm("この PC の設定から、組織の配布設定に切り替えますか？ Google への再同意が必要です。"))
    action(() => window.moriCalendarSetup.useManaged());
});
$("connect").addEventListener("click", () => action(() => window.moriCalendarSetup.connect()));
$("grant-scope").addEventListener("click", () => action(() => window.moriCalendarSetup.connect()));
$("reload-calendars").addEventListener("click", () => action(() => window.moriCalendarSetup.calendars()));
$("apply-selection").addEventListener("click", () => action(async () => {
  const result = await window.moriCalendarSetup.select([...draft]);
  if (result?.ok) { draft = null; showSelection = false; }
  return result;
}));
$("change-selection").addEventListener("click", () => { showSelection = true; draft = null; refresh(); });
$("open-calendar").addEventListener("click", () => action(() => window.moriCalendarSetup.openCalendar()));
$("open-browser").addEventListener("click", () => action(() => window.moriCalendarSetup.openBrowserPanel()));
$("disconnect").addEventListener("click", () => {
  if (window.confirm("この PC の Google 連携と今日の予定の保存結果を削除しますか？"))
    action(() => window.moriCalendarSetup.disconnect());
});
window.moriCalendarSetup.onChange(refresh);
refresh();
