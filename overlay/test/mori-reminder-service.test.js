"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createReminderService, reminderMinutes, quietAt } = require("../src/mori-reminder-service");

test("priority mail alerts only for newly received rows and never exposes content", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-reminders-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const shown = [];
  let time = new Date(2026, 10, 8, 12, 0).getTime();
  class Notice {
    static isSupported() { return true; }
    constructor(options) { shown.push(options); }
    on() {}
    show() {}
  }
  const service = createReminderService({ dataDir, Notification: Notice, now: () => time });
  assert.equal(service.setEnabled("mail", true).ok, true);
  const row = { id: "old", unread: true, receivedAt: time - 3600000, subject: "private" };
  service.onMail({ status: "ready", account: "a@example.com", priority: [row], fetchedAt: time });
  assert.equal(shown.length, 0);
  time += 300000;
  service.onMail({ status: "ready", account: "a@example.com", priority: [row,
    { id: "new", unread: true, receivedAt: time, subject: "secret" }], fetchedAt: time });
  assert.equal(shown.length, 1);
  assert.doesNotMatch(JSON.stringify(shown), /private|secret|a@example.com/);
  service.dispose();
  const again = createReminderService({ dataDir, Notification: Notice, now: () => time });
  again.setEnabled("mail", true);
  again.onMail({ status: "ready", account: "a@example.com", priority: [row], fetchedAt: time - 1000 });
  again.onMail({ status: "ready", account: "a@example.com", priority: [row,
    { id: "new", unread: true, receivedAt: time }], fetchedAt: time });
  assert.equal(shown.length, 1);
  again.dispose();
});

test("calendar uses Google popup reminder offsets, snooze, and local dismiss", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-reminders-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const shown = [];
  let time = new Date(2026, 10, 8, 12, 0).getTime();
  class Notice { static isSupported() { return true; } constructor(options) { shown.push(options); } on() {} show() {} }
  const service = createReminderService({ dataDir, Notification: Notice, now: () => time });
  const event = { key: "0123456789abcdef0123456789abcdef", id: "e1", sourceId: "primary",
    start: new Date(time + 10 * 60000).toISOString(), reminders: { useDefault: true, overrides: [] },
    cached: false, allDay: false, declined: false };
  const calendars = [{ id: "primary", defaultReminders: [10] }];
  assert.deepEqual(reminderMinutes(event, calendars), [10]);
  service.setEnabled("calendar", true);
  service.onCalendar({ status: "ready", events: [event], calendars });
  assert.equal(shown.length, 1);
  service.tick();
  assert.equal(shown.length, 1);
  assert.equal(service.changeEvent(event, "snooze").ok, true);
  time += 10 * 60000;
  service.tick();
  assert.equal(shown.length, 2);
  assert.equal(service.changeEvent(event, "dismiss").ok, true);
  service.tick();
  assert.equal(shown.length, 2);
  service.dispose();
});

test("quiet hours cross midnight and notifications require a supported OS", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-reminders-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.equal(quietAt(new Date(2026, 10, 8, 23).getTime(),
    { quietStart: "22:00", quietEnd: "08:00" }), true);
  assert.equal(quietAt(new Date(2026, 10, 8, 12).getTime(),
    { quietStart: "22:00", quietEnd: "08:00" }), false);
  const service = createReminderService({ dataDir, Notification: { isSupported: () => false } });
  assert.deepEqual(service.setEnabled("mail", true), { ok: false, reason: "unsupported" });
  assert.equal(service.setQuiet("bad", "08:00").ok, false);
  assert.equal(service.setQuiet("23:00", "07:30").ok, true);
  assert.equal(service.stateFor("mail").quietEnd, "07:30");
  service.dispose();
});

test("app do-not-disturb suppresses a due calendar alert", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-reminders-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const shown = [];
  let dnd = true;
  const time = new Date(2026, 10, 8, 12).getTime();
  class Notice { static isSupported() { return true; } constructor(value) { shown.push(value); } on() {} show() {} }
  const service = createReminderService({ dataDir, Notification: Notice, now: () => time,
    suppressed: () => dnd });
  service.setEnabled("calendar", true);
  service.onCalendar({ status: "ready", events: [{ key: "0123456789abcdef0123456789abcdef",
    start: new Date(time + 10 * 60000).toISOString(), sourceId: "primary", reminders: { useDefault: true },
    cached: false, allDay: false }], calendars: [{ id: "primary", defaultReminders: [10] }] });
  assert.equal(shown.length, 0);
  dnd = false; service.tick();
  assert.equal(shown.length, 1);
  service.dispose();
});
