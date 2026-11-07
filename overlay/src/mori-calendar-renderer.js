"use strict";
const $ = id => document.getElementById(id);
let busy = false;
let expandedId = null;
let selectionOpen = false;
let draftSelection = null;
const formatDate = value => new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(value);
const formatClock = value => new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const formatShortDate = value => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" }).format(value);
function timeText(event) {
  if (event.allDay) return "終日";
  const start = new Date(event.start), end = new Date(event.end);
  if (start.toDateString() === end.toDateString()) return formatClock(start) + "–" + formatClock(end);
  return formatShortDate(start) + " " + formatClock(start)
    + "–" + formatShortDate(end) + " " + formatClock(end);
}
function field(label, content) {
  const row = document.createElement("div"); row.className = "field";
  const name = document.createElement("strong"); name.textContent = label;
  const value = document.createElement("div"); value.className = "value";
  if (typeof content === "string") value.textContent = content;
  else value.append(content);
  row.append(name, value); return row;
}
function renderEvent(event, data) {
  const key = event.key || event.id;
  const card = document.createElement("details"); card.className = "event";
  if (event.declined) card.classList.add("declined");
  card.open = expandedId === key;
  const summary = document.createElement("summary");
  const title = document.createElement("span"); title.className = "event-title";
  title.textContent = event.title + (event.declined ? " · 辞退済み" : "");
  const time = document.createElement("time"); time.className = "event-time";
  time.textContent = timeText(event);
  const source = document.createElement("span"); source.className = "event-source";
  source.textContent = event.sourceName || "メイン"; source.title = source.textContent;
  summary.append(title, time, source);
  summary.addEventListener("click", clickEvent => {
    clickEvent.preventDefault();
    const opening = !card.open;
    for (const other of document.querySelectorAll("#events > .event[open]")) other.open = false;
    card.open = opening;
    expandedId = opening ? key : null;
  });
  const detail = document.createElement("div"); detail.className = "event-detail";
  detail.append(field("時間", timeText(event)), field("出所", event.sourceName || "メイン"),
    field("内容", event.description || "説明なし"));
  const minutes = event.reminders?.useDefault
    ? data.calendars.find(item => item.id === event.sourceId)?.defaultReminders || []
    : event.reminders?.overrides || [];
  if (!event.allDay && minutes.length) {
    const notice = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = `Google のポップアップ通知: ${minutes.join("、")} 分前`;
    const snooze = document.createElement("button"); snooze.textContent = "10分後に再通知";
    const dismiss = document.createElement("button"); dismiss.textContent = "この予定の通知を解除";
    for (const [button, action] of [[snooze, "snooze"], [dismiss, "dismiss"]]) {
      button.addEventListener("click", async () => {
        const result = await window.moriCalendar.reminderAction(key, action);
        label.textContent = result?.ok ? action === "snooze" ? "この PC で10分後に再通知します。"
          : "この PC で、この予定の通知を解除しました。" : "通知設定を変更できませんでした。";
      });
    }
    notice.append(label, snooze, dismiss);
    detail.append(field("通知", notice));
  }
  if (event.url) {
    const link = document.createElement("div");
    const text = document.createElement("span"); text.className = "url"; text.textContent = event.url; text.title = event.url;
    const actions = document.createElement("div"); actions.className = "link-actions";
    const open = document.createElement("button"); open.textContent = event.urlKind === "join" ? "参加" : "予定を開く";
    open.addEventListener("click", () => window.moriCalendar.openLink(key));
    const copy = document.createElement("button"); copy.textContent = "URL をコピー";
    copy.addEventListener("click", () => window.moriCalendar.copyLink(key));
    actions.append(open, copy); link.append(text, actions);
    detail.append(field("URL", link));
  } else detail.append(field("URL", "URL なし"));
  card.append(summary, detail);
  return card;
}
function renderSelection(data) {
  $("selection").hidden = !selectionOpen;
  if (!selectionOpen) return;
  if (!draftSelection) draftSelection = new Set(data.selectedIds || ["primary"]);
  const notices = {
    "scope-needed": "共有カレンダーの一覧には追加の権限が必要です。下の「追加権限を許可」から再連携してください。",
    "permission-denied": "一覧を読む権限がありません。追加権限を確認してください。",
    "google-quota": "Google の利用枠により一覧を停止しました。",
    "local-limit": "この PC の取得上限により一覧を停止しました。",
    waiting: "次のカレンダー一覧更新時刻を待っています。",
    failed: "カレンダー一覧を取得できませんでした。",
  };
  const notice = notices[data.listStatus];
  const updateSelectionNote = (limitReached = false) => {
    const guidance = limitReached || draftSelection.size === 3
      ? "最大3件です。別のカレンダーを選ぶには、選択済みのチェックを1つ外してください。"
      : "最大3件まで選べます。0件なら予定取得を停止します。";
    $("selection-note").textContent = `${notice ? notice + " " : ""}選択中: ${draftSelection.size}/3。${guidance}`;
    $("apply-selection").disabled = busy || draftSelection.size > 3;
  };
  updateSelectionNote();
  const choices = data.calendars?.length ? data.calendars : [{ id: "primary", name: "メイン", readable: true }];
  const options = choices.map(item => {
    const label = document.createElement("label"); label.className = "calendar-option";
    if (!item.readable) label.classList.add("unreadable");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox";
    checkbox.checked = draftSelection.has(item.id); checkbox.disabled = !item.readable;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) draftSelection.add(item.id); else draftSelection.delete(item.id);
      if (draftSelection.size > 3) { checkbox.checked = false; draftSelection.delete(item.id); }
      updateSelectionNote();
    });
    const name = document.createElement("span"); name.textContent = item.name;
    label.append(checkbox, name); return label;
  });
  for (const id of [...draftSelection]) {
    if (!choices.some(item => item.id === id)) {
      const label = document.createElement("label"); label.className = "calendar-option unreadable";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = true;
      checkbox.addEventListener("change", () => { if (!checkbox.checked) draftSelection.delete(id); updateSelectionNote(); });
      const name = document.createElement("span"); name.textContent = "取得不可: " + id.slice(0, 80);
      label.append(checkbox, name); options.push(label);
    }
  }
  $("calendar-options").replaceChildren(...options);
  $("reload-calendars").disabled = busy || !data.listScope;
}
function render(data) {
  $("auto-open").checked = data.autoOpen !== false;
  $("calendar-notify").checked = data.notification?.enabled === true;
  $("calendar-notify").disabled = data.notification?.supported !== true;
  $("calendar-quiet-start").value = data.notification?.quietStart || "22:00";
  $("calendar-quiet-end").value = data.notification?.quietEnd || "08:00";
  $("notification-status").textContent = data.notification?.supported
    ? "通知はこの PC で管理します。停止時間はメール通知と共通です。"
    : "この環境で OS 通知を利用できません。";
  $("pin").checked = data.pinned !== false;
  if ([1, 1.25, 1.5].includes(data.zoom)) $("text-size").value = String(data.zoom);
  $("window-size").value = data.sizeMode || ({ "400x480": "standard", "520x620": "large", "640x760": "extra" })[
    `${data.width}x${data.height}`] || "custom";
  if (!data.events.some(event => (event.key || event.id) === expandedId)) expandedId = null;
  $("date").textContent = formatDate(new Date(data.date + "T00:00:00"));
  const labels = {
    "config-needed": "組織の Google Calendar 設定を待っています。",
    "secure-storage-unavailable": "OS の保護された鍵保存を利用できません。",
    unlinked: "Google Calendar を連携してください。",
    authorizing: "Google アカウントの同意を待っています。",
    loading: "今日の予定を取得しています…",
    ready: data.events.length ? data.events.length + " 件の予定"
      : data.fromCache ? "前回取得時の今日の予定はありません。" : "今日の予定はありません。",
    partial: "一部のカレンダーを取得できませんでした。",
    "no-selection": "表示するカレンダーを選択してください。",
    waiting: "次の更新時刻を待っています。",
    "local-limit": "この PC の取得上限に達しました。自動更新を停止しています。",
    "quota-paused": "Google の利用枠に達したため、自動更新を停止しています。",
    "auth-expired": "Google Calendar の再連携が必要です。",
    "config-changed": "接続設定が変わりました。設定画面で再連携してください。",
    "auth-failed": data.reason === "client-secret-required"
      ? "OAuth 設定にクライアント シークレットが必要です。設定を確認してください。"
      : "連携できませんでした。もう一度お試しください。",
    failed: "予定を取得できませんでした。",
    "storage-error": "予定の保存領域を読み取れません。",
  };
  const next = Number.isSafeInteger(data.nextAt) && data.nextAt > Date.now()
    ? " 次回確認: " + formatDate(new Date(data.nextAt)) + " " + formatClock(data.nextAt) : "";
  $("state").textContent = (labels[data.status] || "予定の状態を確認できません。")
    + (["waiting", "local-limit", "quota-paused", "failed"].includes(data.status) ? next : "");
  $("updated").textContent = data.fetchedAt ? "最終取得: " + formatDate(new Date(data.fetchedAt)) + " " + formatClock(data.fetchedAt)
    + (data.fromCache || data.status !== "ready" ? "（以前の取得結果）" : "")
    + (data.cacheSaved === false ? "・保存できず、次回起動時に再取得" : "") : "";
  $("source-status").textContent = (data.sources || []).filter(item => item.status !== "success")
    .map(item => item.name + ": " + ({ missing: "未取得", "permission-denied": "権限不足",
      "calendar-not-found": "アクセス不可", "local-limit": "上限停止", "google-quota": "利用枠停止",
      cached: "以前の取得結果" }[item.status] || "取得失敗"))
    .join(" / ");
  $("usage").textContent = data.requestCount == null ? "この PC の取得回数は確認できません。Cloud の実効枠・使用量は別途 Console で確認してください。"
    : `この PC の API リクエスト予約回数: ${data.requestCount} / ${data.requestLimit} 回（直近24時間、端末内の上限）。Cloud の実効枠・使用量とは異なります。`;
  const scrollTop = $("events").scrollTop;
  $("events").replaceChildren(...data.events.map(event => renderEvent(event, data)));
  $("events").scrollTop = scrollTop;
  $("connect").hidden = !["unlinked", "auth-expired", "auth-failed", "config-changed"].includes(data.status)
    && (data.listScope || ["config-needed", "secure-storage-unavailable", "storage-error"].includes(data.status));
  $("connect").textContent = ["unlinked", "auth-failed", "config-changed", "auth-expired"].includes(data.status)
    ? "連携を設定" : "追加権限を許可";
  $("choose").hidden = ["unlinked", "config-needed", "secure-storage-unavailable", "storage-error", "auth-failed"].includes(data.status);
  $("disconnect").hidden = ["unlinked", "config-needed", "secure-storage-unavailable", "storage-error"].includes(data.status);
  $("refresh").disabled = busy || !["ready", "partial", "failed", "waiting", "local-limit"].includes(data.status);
  renderSelection(data);
}
async function refresh() {
  try { const data = await window.moriCalendar.state(); if (data?.ok) render(data); }
  catch { $("state").textContent = "表示を更新できません。"; }
}
async function action(fn) {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true; $("connect").disabled = true; $("disconnect").disabled = true;
  try { await fn(); } finally {
    busy = false; $("connect").disabled = false; $("disconnect").disabled = false;
    await refresh();
  }
}
$("close").addEventListener("click", () => window.moriCalendar.close());
$("text-size").addEventListener("change", () => window.moriCalendar.setZoom(Number($("text-size").value)));
$("window-size").addEventListener("change", async () => {
  try {
    const result = await window.moriCalendar.setSize($("window-size").value);
    if (!result?.ok) throw new Error("size-failed");
    await refresh();
  } catch {
    await refresh();
    $("state").textContent = "窓サイズを変更できませんでした。";
  }
});
let gripSession = null;
$("resize-grip").addEventListener("pointerdown", event => {
  if (event.button !== 0 || gripSession) return;
  event.preventDefault();
  const grip = $("resize-grip");
  grip.setPointerCapture(event.pointerId);
  const session = { pointerId: event.pointerId, ready: false, lastMove: null };
  gripSession = session;
  session.start = window.moriCalendar.resizeGrip("start").then(result => {
    if (gripSession === session) session.ready = result?.ok === true;
    return result;
  }).catch(() => ({ ok: false }));
});
$("resize-grip").addEventListener("pointermove", event => {
  const session = gripSession;
  if (session?.pointerId === event.pointerId && session.ready)
    session.lastMove = window.moriCalendar.resizeGrip("move").catch(() => ({ ok: false }));
});
async function finishGrip(event) {
  const session = gripSession;
  if (!session || session.pointerId !== event.pointerId) return;
  gripSession = null;
  try {
    if ((await session.start)?.ok) {
      await session.lastMove;
      await window.moriCalendar.resizeGrip("move");
      await window.moriCalendar.resizeGrip("end");
    }
  } catch { $("state").textContent = "窓サイズを変更できませんでした。"; }
  finally { await refresh(); }
}
$("resize-grip").addEventListener("pointerup", finishGrip);
$("resize-grip").addEventListener("pointercancel", finishGrip);
$("pin").addEventListener("change", () => window.moriCalendar.setPinned($("pin").checked));
$("auto-open").addEventListener("change", async () => {
  const enabled = $("auto-open").checked;
  try {
    const result = await window.moriCalendar.setAutoOpen(enabled);
    if (!result?.ok) throw new Error("save-failed");
  } catch {
    $("auto-open").checked = !enabled;
    $("state").textContent = "起動設定を保存できませんでした。";
  }
});
$("calendar-notify").addEventListener("change", async () => {
  const enabled = $("calendar-notify").checked;
  const result = await window.moriCalendar.setNotification(enabled).catch(() => null);
  if (!result?.ok) { $("calendar-notify").checked = !enabled;
    $("notification-status").textContent = "通知設定を保存できませんでした。"; }
});
for (const id of ["calendar-quiet-start", "calendar-quiet-end"]) $(id).addEventListener("change", async () => {
  const result = await window.moriCalendar.setQuiet($("calendar-quiet-start").value,
    $("calendar-quiet-end").value).catch(() => null);
  if (!result?.ok) $("notification-status").textContent = "通知停止時間を保存できませんでした。";
});
$("setup").addEventListener("click", () => window.moriCalendar.openSetup());
$("connect").addEventListener("click", () => window.moriCalendar.openSetup());
$("refresh").addEventListener("click", () => action(() => window.moriCalendar.refresh()));
$("disconnect").addEventListener("click", () => action(() => window.moriCalendar.disconnect()));
$("choose").addEventListener("click", () => { selectionOpen = !selectionOpen; draftSelection = null; refresh(); });
$("apply-selection").addEventListener("click", () => action(async () => {
  const result = await window.moriCalendar.select([...draftSelection]);
  if (result?.ok) { selectionOpen = false; draftSelection = null; }
  else $("selection-note").textContent = "選択を保存できませんでした。";
}));
$("reload-calendars").addEventListener("click", () => action(() => window.moriCalendar.calendars()));
window.moriCalendar.onChange(refresh);
refresh();
