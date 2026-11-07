"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { openJsonFile } = require("./browser-bridge-persistence");

const DAY = 86400000;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT = { version: 1, mailEnabled: false, calendarEnabled: false,
  quietStart: "22:00", quietEnd: "08:00", notified: [], dismissed: [], snoozes: [] };

function valid(value) {
  if (!value || value.version !== 1 || typeof value.mailEnabled !== "boolean"
    || typeof value.calendarEnabled !== "boolean" || !CLOCK.test(value.quietStart)
    || !CLOCK.test(value.quietEnd) || !Array.isArray(value.notified)
    || !Array.isArray(value.dismissed) || !Array.isArray(value.snoozes)
    || value.notified.length > 1000 || value.dismissed.length > 1000 || value.snoozes.length > 200
    || ![...value.notified, ...value.dismissed, ...value.snoozes].every(item =>
      HASH.test(item?.key) && Number.isSafeInteger(item.at) && item.at > 0))
    throw new Error("invalid-reminder-state");
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function eventKey(event) { return hash(`${event.key || event.id}\0${event.start}`); }
function quietAt(now, state) {
  const date = new Date(now), minutes = date.getHours() * 60 + date.getMinutes();
  const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = toMinutes(state.quietStart), end = toMinutes(state.quietEnd);
  return start === end ? false : start < end ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}
function reminderMinutes(event, calendars) {
  if (event.reminders?.useDefault) {
    return calendars.find(item => item.id === event.sourceId)?.defaultReminders || [];
  }
  return event.reminders?.overrides || [];
}

function createReminderService({ dataDir, Notification, now = Date.now,
  openMail = () => {}, openCalendar = () => {}, suppressed = () => false }) {
  const file = openJsonFile(path.join(dataDir, "reminders.json"), valid, { maxBytes: 120000 });
  let state = file.value || { ...DEFAULT };
  let calendar = null, mail = null, mailSeen = new Set(), mailBaseline = false;
  let timer = null;
  function save(next) {
    valid(next);
    file.write(next);
    state = next;
  }
  function prune(at) {
    const keep = items => items.filter(item => item.at > at - 3 * DAY).slice(-800);
    save({ ...state, notified: keep(state.notified), dismissed: keep(state.dismissed),
      snoozes: state.snoozes.filter(item => item.at > at - DAY).slice(-200) });
  }
  function supported() { try { return Notification?.isSupported?.() === true; } catch { return false; } }
  function show(title, body, click) {
    if (!supported()) return false;
    try {
      const notice = new Notification({ title, body });
      notice.on?.("click", click);
      notice.show();
      return true;
    } catch { return false; }
  }
  function stateFor(kind) {
    return { enabled: state[kind + "Enabled"], supported: supported(),
      quietStart: state.quietStart, quietEnd: state.quietEnd };
  }
  function setEnabled(kind, enabled) {
    if (!["mail", "calendar"].includes(kind) || typeof enabled !== "boolean")
      return { ok: false, reason: "invalid-setting" };
    if (enabled && !supported()) return { ok: false, reason: "unsupported" };
    try { save({ ...state, [kind + "Enabled"]: enabled }); }
    catch { return { ok: false, reason: "storage-error" }; }
    if (enabled && kind === "calendar") tick();
    return { ok: true, ...stateFor(kind) };
  }
  function setQuiet(start, end) {
    if (!CLOCK.test(start) || !CLOCK.test(end)) return { ok: false, reason: "invalid-setting" };
    try { save({ ...state, quietStart: start, quietEnd: end }); }
    catch { return { ok: false, reason: "storage-error" }; }
    return { ok: true };
  }
  function onMail(snapshot) {
    if (!snapshot || !["ready", "partial"].includes(snapshot.status) || !snapshot.account) return;
    const rows = snapshot.priority || [];
    const current = new Set(rows.map(row => row.id));
    if (!mailBaseline || mail?.account !== snapshot.account) {
      mailBaseline = true; mailSeen = current; mail = snapshot; return;
    }
    const previousFetch = mail.fetchedAt || 0;
    if (state.mailEnabled && !quietAt(now(), state) && !suppressed() && snapshot.fetchedAt > previousFetch) {
      for (const row of rows) {
        const key = hash(`${snapshot.account}\0${row.id}`);
        if (mailSeen.has(row.id) || !row.unread || row.receivedAt < previousFetch - 60000
          || state.notified.some(item => item.key === key)) continue;
        if (!supported()) continue;
        try { save({ ...state, notified: [...state.notified, { key, at: now() }].slice(-1000) }); }
        catch { /* Do not show a notice without a durable duplicate guard. */ break; }
        show("優先送信者から新着メール", "Mori Desk の受信メールを確認してください。", openMail);
      }
    }
    mailSeen = current; mail = snapshot;
  }
  function onCalendar(snapshot) { calendar = snapshot; tick(); }
  function tick() {
    if (!state.calendarEnabled || !calendar || !["ready", "partial"].includes(calendar.status)) return;
    const at = now();
    if (quietAt(at, state) || suppressed()) return;
    for (const event of calendar.events || []) {
      if (event.declined || event.cached || event.allDay) continue;
      const occurrence = eventKey(event);
      if (state.dismissed.some(item => item.key === occurrence)) continue;
      const snooze = state.snoozes.find(item => item.key === occurrence);
      const times = snooze ? [snooze.at] : reminderMinutes(event, calendar.calendars)
        .map(minutes => Date.parse(event.start) - minutes * 60000);
      for (const time of times) {
        if (!Number.isFinite(time) || time > at || time <= at - 5 * 60000) continue;
        const key = hash(`${occurrence}\0${time}`);
        if (state.notified.some(item => item.key === key)) continue;
        if (!supported()) continue;
        try { save({ ...state, notified: [...state.notified, { key, at }].slice(-1000),
          snoozes: snooze ? state.snoozes.filter(item => item.key !== occurrence) : state.snoozes }); }
        catch { return; }
        show("予定の通知", "Mori Desk の今日の予定を確認してください。", openCalendar);
      }
    }
  }
  function changeEvent(event, kind) {
    if (!event || !calendar?.events?.some(item => item.key === event.key && item.start === event.start))
      return { ok: false, reason: "event-missing" };
    const key = eventKey(event), at = now();
    try {
      if (kind === "dismiss") save({ ...state, dismissed: [...state.dismissed.filter(item => item.key !== key), { key, at }].slice(-1000),
        snoozes: state.snoozes.filter(item => item.key !== key) });
      else if (kind === "snooze") save({ ...state, snoozes: [...state.snoozes.filter(item => item.key !== key),
        { key, at: at + 10 * 60000 }].slice(-200) });
      else return { ok: false, reason: "invalid-action" };
    } catch { return { ok: false, reason: "storage-error" }; }
    return { ok: true };
  }
  function start() { if (!timer) { timer = setInterval(tick, 60000); prune(now()); } }
  function dispose() { if (timer) clearInterval(timer); timer = null; }
  return { start, dispose, onMail, onCalendar, tick, stateFor, setEnabled, setQuiet,
    changeEvent, enabled: kind => state[kind + "Enabled"] };
}

module.exports = { createReminderService, valid, quietAt, reminderMinutes, eventKey };
