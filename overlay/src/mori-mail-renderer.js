"use strict";
const $ = id => document.getElementById(id);
let busy = false, expandedId = null, settingsOpen = false, current = null;
const clock = value => new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit" }).format(new Date(value));
function field(label, content) {
  const row = document.createElement("div"); row.className = "field";
  const name = document.createElement("strong"); name.textContent = label;
  const value = document.createElement("div"); value.className = "value";
  value.textContent = content;
  row.append(name, value); return row;
}
function button(text, action) {
  const item = document.createElement("button"); item.type = "button"; item.textContent = text;
  item.addEventListener("click", action); return item;
}
function renderMail(mail, priority) {
  const card = document.createElement("details"); card.className = "event";
  if (mail.unread) card.classList.add("mail-unread");
  card.open = expandedId === mail.id;
  const summary = document.createElement("summary");
  const from = document.createElement("span"); from.className = "mail-from";
  from.textContent = mail.from || mail.sender || "送信者不明"; from.title = from.textContent;
  const title = document.createElement("span"); title.className = "mail-subject";
  title.textContent = mail.subject;
  const time = document.createElement("time"); time.className = "mail-time";
  time.dateTime = new Date(mail.receivedAt).toISOString(); time.textContent = clock(mail.receivedAt);
  summary.append(from, title, time);
  const detail = document.createElement("div"); detail.className = "mail-detail";
  detail.append(field("送信者", mail.from || mail.sender || "不明"),
    field("受信", clock(mail.receivedAt)), field("宛先", mail.to || "不明"),
    field("概要", mail.snippet || "なし"), field("アカウント", current.account || "不明"),
    field("URL", mail.url ? mail.url + "（Gmail の画面形式は変更される場合があります）" : "利用不可"));
  const body = field("本文", "読み込み中…"); detail.append(body);
  const actions = document.createElement("div"); actions.className = "mail-actions";
  actions.append(button("Gmail で開く", () => action(() => window.moriMail.openLink(mail.id))),
    button("URL をコピー", () => action(() => window.moriMail.copyLink(mail.id))));
  if (priority) actions.append(button("一覧から除外", () => action(() => window.moriMail.hide(mail.id))));
  detail.append(actions);
  summary.addEventListener("click", event => {
    event.preventDefault();
    const opening = !card.open;
    for (const other of document.querySelectorAll("#events details[open]")) other.open = false;
    card.open = opening; expandedId = opening ? mail.id : null;
    if (opening) void window.moriMail.detail(mail.id).then(result => {
      if (card.open) body.querySelector(".value").textContent = result.ok
        ? result.body || "プレーンテキスト本文はありません。Gmail で確認してください。"
        : "本文を取得できませんでした。Gmail で確認してください。";
    }).catch(() => { if (card.open) body.querySelector(".value").textContent = "本文を取得できませんでした。"; });
  });
  card.append(summary, detail); return card;
}
function renderSection(id, rows, priority) {
  const target = $(id);
  target.replaceChildren(...(rows.length ? rows.map(row => renderMail(row, priority)) : [(() => {
    const empty = document.createElement("p"); empty.className = "mail-empty";
    empty.textContent = priority ? "優先メールはありません。" : "未読メールはありません。";
    return empty;
  })()]));
  $(id + "-count").textContent = `${rows.length}件`;
}
function renderSenders(data) {
  $("senders").replaceChildren(...data.senders.map(address => {
    const row = document.createElement("div"); row.className = "sender-row";
    const text = document.createElement("span"); text.textContent = address;
    row.append(text, button("削除", () => action(() => window.moriMail.senders(
      data.senders.filter(item => item !== address)))));
    return row;
  }));
}
function render(data) {
  $("auto-open").checked = data.autoOpen !== false;
  $("pin").checked = data.pinned !== false;
  if ([1, 1.25, 1.5].includes(data.zoom)) $("text-size").value = String(data.zoom);
  $("window-size").value = data.sizeMode || ({ "400x480": "standard", "520x620": "large", "640x760": "extra" })[
    `${data.width}x${data.height}`] || "custom";
  current = data;
  if (![...data.priority, ...data.unread].some(row => row.id === expandedId)) expandedId = null;
  $("account").textContent = data.account || "Gmail を連携してください";
  const labels = { "config-needed": "Gmail 用 Desktop OAuth 設定が必要です。", unlinked: "Gmail を連携してください。",
    authorizing: "Google アカウントの同意を待っています。", loading: "メールを取得しています…",
    ready: `${data.priority.length}件の優先メール・${data.unread.length}件のその他の未読`,
    partial: data.gap ? "同期履歴に欠落の可能性があります。"
      : data.pendingCount ? `差分を処理中です（残り${data.pendingCount}件）。`
        : "未読の一部は未取得です。", waiting: "次の更新を待っています。",
    "auth-expired": "Gmail の再連携が必要です。", "quota-paused": "Google の利用枠で取得を停止しました。",
    "local-limit": "この PC の取得上限で停止しました。", "secure-storage-unavailable": "安全な保存領域を利用できません。",
    "storage-error": "メールの保存領域を確認できません。", failed: "メールを更新できませんでした。" };
  $("state").textContent = labels[data.status] || "メールの状態を確認できません。";
  if (data.nextAt && data.nextAt > Date.now()) $("state").textContent += " 次回: " + clock(data.nextAt);
  $("updated").textContent = data.fetchedAt ? `最終取得: ${clock(data.fetchedAt)}${data.status !== "ready" ? "（以前の取得結果）" : ""}` : "";
  const scrollTop = $("events").scrollTop;
  renderSection("priority", data.priority, true);
  renderSection("unread", data.unread, false);
  $("events").scrollTop = scrollTop;
  $("partial").hidden = !data.partial;
  $("partial").textContent = data.gap ? "履歴が期限切れとなり、既読の優先メールに欠落の可能性があります。"
    : data.pendingCount ? `差分を処理中です（残り${data.pendingCount}件）。`
      : "以前の未読の一部は未取得です。";
  $("more").hidden = !data.nextPageToken;
  $("more").disabled = busy || ["loading", "quota-paused", "local-limit"].includes(data.status);
  $("settings").hidden = !settingsOpen;
  $("connect").hidden = !["unlinked", "auth-expired", "failed"].includes(data.status);
  $("disconnect").hidden = !data.account;
  $("refresh").disabled = busy || !data.account || ["loading", "quota-paused", "local-limit"].includes(data.status);
  $("usage").textContent = data.requestUnits == null ? "" : `この PC の API 利用量: ${data.requestUnits} / ${data.requestLimit} units（24時間）`;
  renderSenders(data);
}
async function refresh() {
  try { const data = await window.moriMail.state(); if (data?.ok) render(data); }
  catch { $("state").textContent = "表示を更新できません。"; }
}
async function action(fn) {
  if (busy) return;
  busy = true; $("refresh").disabled = true;
  try { const result = await fn();
    if (result?.ok === false && result.reason !== "cancelled") $("state").textContent = "操作を完了できませんでした。";
  } finally { busy = false; await refresh(); }
}
$("close").addEventListener("click", () => window.moriMail.close());
$("text-size").addEventListener("change", () => window.moriMail.setZoom(Number($("text-size").value)));
$("window-size").addEventListener("change", async () => {
  try {
    const result = await window.moriMail.setSize($("window-size").value);
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
  session.start = window.moriMail.resizeGrip("start").then(result => {
    if (gripSession === session) session.ready = result?.ok === true;
    return result;
  }).catch(() => ({ ok: false }));
});
$("resize-grip").addEventListener("pointermove", event => {
  const session = gripSession;
  if (session?.pointerId === event.pointerId && session.ready)
    session.lastMove = window.moriMail.resizeGrip("move").catch(() => ({ ok: false }));
});
async function finishGrip(event) {
  const session = gripSession;
  if (!session || session.pointerId !== event.pointerId) return;
  gripSession = null;
  try {
    if ((await session.start)?.ok) {
      await session.lastMove;
      await window.moriMail.resizeGrip("move");
      await window.moriMail.resizeGrip("end");
    }
  } catch { $("state").textContent = "窓サイズを変更できませんでした。"; }
  finally { await refresh(); }
}
$("resize-grip").addEventListener("pointerup", finishGrip);
$("resize-grip").addEventListener("pointercancel", finishGrip);
$("pin").addEventListener("change", () => window.moriMail.setPinned($("pin").checked));
$("auto-open").addEventListener("change", async () => {
  const enabled = $("auto-open").checked;
  try {
    const result = await window.moriMail.setAutoOpen(enabled);
    if (!result?.ok) throw new Error("save-failed");
  } catch {
    $("auto-open").checked = !enabled;
    $("state").textContent = "起動設定を保存できませんでした。";
  }
});
$("settings-toggle").addEventListener("click", () => { settingsOpen = !settingsOpen; refresh(); });
$("refresh").addEventListener("click", () => action(() => window.moriMail.refresh()));
$("more").addEventListener("click", () => action(() => window.moriMail.more()));
$("connect").addEventListener("click", () => action(async () => {
  const result = await window.moriMail.connect();
  if (result?.ok && result.account) settingsOpen = false;
  return result;
}));
$("disconnect").addEventListener("click", () => action(() => window.moriMail.disconnect()));
$("import").addEventListener("click", () => action(() => window.moriMail.importConfig()));
$("google-setup").addEventListener("click", () => action(() => window.moriMail.openGoogleSetup()));
$("add-sender").addEventListener("click", () => action(async () => {
  const value = $("sender").value.trim().toLowerCase();
  const result = await window.moriMail.senders([...new Set([...(current?.senders || []), value])]);
  if (result.ok) $("sender").value = "";
  return result;
}));
window.moriMail.onChange(refresh);
refresh();
