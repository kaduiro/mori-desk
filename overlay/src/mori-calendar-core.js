"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 100;
const AUTO_INTERVAL_MS = 30 * 60 * 1000;
const MULTI_AUTO_INTERVAL_MS = 60 * 60 * 1000;
const MANUAL_INTERVAL_MS = 5 * 60 * 1000;

function dayBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { key: [start.getFullYear(), String(start.getMonth() + 1).padStart(2, "0"), String(start.getDate()).padStart(2, "0")].join("-"),
    start: start.toISOString(), end: end.toISOString() };
}

function safeHttps(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function eventLink(event) {
  const video = event?.conferenceData?.entryPoints?.find(point => point?.entryPointType === "video" && safeHttps(point.uri));
  const meeting = safeHttps(video?.uri) || safeHttps(event?.hangoutLink);
  if (meeting) return { url: meeting, kind: "join" };
  const page = safeHttps(event?.htmlLink);
  return page ? { url: page, kind: "event" } : { url: null, kind: "none" };
}

function normalizeEvent(event) {
  if (!event || event.status === "cancelled") return null;
  if (typeof event.id !== "string" || !event.id || event.id.length > 512) return null;
  const allDay = typeof event.start?.date === "string";
  const start = allDay ? event.start.date : event.start?.dateTime;
  const end = allDay ? event.end?.date : event.end?.dateTime;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!allDay && (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)))) return null;
  if (allDay && (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))) return null;
  const link = eventLink(event);
  const reminders = event.reminders && typeof event.reminders === "object"
    ? { useDefault: event.reminders.useDefault === true,
      overrides: Array.isArray(event.reminders.overrides) ? event.reminders.overrides
        .filter(item => item?.method === "popup" && Number.isSafeInteger(item.minutes)
          && item.minutes >= 0 && item.minutes <= 40320).slice(0, 5)
        .map(item => item.minutes) : [] } : { useDefault: false, overrides: [] };
  return {
    id: event.id,
    title: String(event.summary || "無題の予定").slice(0, 500),
    description: String(event.description || "").slice(0, 20000),
    start, end, allDay, url: link.url, urlKind: link.kind, reminders,
    declined: Array.isArray(event.attendees) && event.attendees.some(person => person?.self === true && person.responseStatus === "declined"),
  };
}

function normalizeEvents(items) {
  return (Array.isArray(items) ? items : []).map(normalizeEvent).filter(Boolean)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay)
      || (a.allDay ? String(a.start).localeCompare(String(b.start))
        : Date.parse(a.start) - Date.parse(b.start)) || a.title.localeCompare(b.title));
}

function sortEvents(events) {
  return [...events].sort((a, b) => Number(b.allDay) - Number(a.allDay)
    || (a.allDay ? String(a.start).localeCompare(String(b.start))
      : Date.parse(a.start) - Date.parse(b.start))
    || a.title.localeCompare(b.title) || String(a.key || a.id).localeCompare(String(b.key || b.id)));
}

function cycleAllowance(lastAt, now, manual, count) {
  const interval = manual ? MANUAL_INTERVAL_MS : count > 1 ? MULTI_AUTO_INTERVAL_MS : AUTO_INTERVAL_MS;
  return lastAt && now - lastAt < interval
    ? { allowed: false, reason: "interval", nextAt: lastAt + interval }
    : { allowed: true };
}

function requestAllowance(timestamps, now, manual = false) {
  const recent = (Array.isArray(timestamps) ? timestamps : [])
    .filter(value => Number.isSafeInteger(value) && value <= now && value > now - DAY_MS).sort((a, b) => a - b);
  if (recent.length >= MAX_REQUESTS) return { allowed: false, reason: "local_limit", nextAt: recent[0] + DAY_MS, recent };
  const last = recent.at(-1) || 0;
  const interval = manual ? MANUAL_INTERVAL_MS : AUTO_INTERVAL_MS;
  if (last && now - last < interval) return { allowed: false, reason: "interval", nextAt: last + interval, recent };
  return { allowed: true, recent };
}

module.exports = { DAY_MS, MAX_REQUESTS, AUTO_INTERVAL_MS, MULTI_AUTO_INTERVAL_MS, MANUAL_INTERVAL_MS,
  dayBounds, safeHttps, eventLink, normalizeEvent, normalizeEvents, sortEvents, cycleAllowance, requestAllowance };
