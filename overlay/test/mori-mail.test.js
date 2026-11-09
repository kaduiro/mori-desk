"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../src/mori-mail-core");
const { createMailStore } = require("../src/mori-mail-store");
const api = require("../src/mori-mail-api");
const { createMailRuntime } = require("../src/mori-mail-runtime");

function storage() {
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "dpapi",
    encryptString: value => Buffer.from("sealed:" + value),
    decryptString: value => value.toString().slice(7) };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-mail-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "client.json"), JSON.stringify({
    clientId: "123-test.apps.googleusercontent.com", clientSecret: "test-secret" }));
  return dir;
}
function message(id, from, labels, receivedAt) {
  return { id, threadId: id + "thread", internalDate: String(receivedAt), labelIds: labels,
    snippet: "短い抜粋", payload: { headers: [{ name: "From", value: from },
      { name: "Subject", value: "業務の件" }, { name: "To", value: "worker@example.com" }] } };
}

test("sender classification uses address, not display name, and preserves priority after read", () => {
  const priority = core.normalizeMessage(message("a1234567", "Chief <boss@example.com>", ["INBOX"], 20));
  const unread = core.normalizeMessage(message("b1234567", "boss@example.net", ["INBOX", "UNREAD"], 10));
  const result = core.sections([unread, priority], ["boss@example.com"], []);
  assert.deepEqual(result.priority.map(row => row.id), ["a1234567"]);
  assert.deepEqual(result.unread.map(row => row.id), ["b1234567"]);
});

test("mail store seals auth and enforces a persistent quota budget", t => {
  const dir = fixture(t);
  const store = createMailStore({ dataDir: dir, safeStorage: storage() });
  store.saveAuth("worker@example.com", "refresh-secret");
  assert.equal(store.readAuth().account, "worker@example.com");
  assert.equal(fs.readFileSync(path.join(dir, "auth.json"), "utf8").includes("refresh-secret"), false);
  for (let i = 0; i < 25; i++) assert.equal(store.reserve(1000 + i, 100).allowed, true);
  assert.equal(store.reserve(1030, 1).reason, "minute-limit");
  const restarted = createMailStore({ dataDir: dir, safeStorage: storage() });
  assert.equal(restarted.usage(1030).units, 2500);
  assert.equal(restarted.usage(1030).minuteUnits, 2500);
  assert.equal(restarted.usage(1030).minuteLimit, 2500);
  assert.equal(restarted.usage(62030).units, 2500);
  assert.equal(restarted.usage(62030).minuteUnits, 0);
  restarted.disconnect();
  assert.equal(fs.existsSync(path.join(dir, "auth.json")), false);
});

test("mail diagnostics recompute remaining-budget inputs when the rolling minute expires", t => {
  const dir = fixture(t);
  const store = createMailStore({ dataDir: dir, safeStorage: storage() });
  assert.equal(store.reserve(1000, 100).allowed, true);
  let time = 1030;
  const runtime = createMailRuntime({ dataDir: dir, safeStorage: storage(), shell: {}, now: () => time });
  assert.equal(runtime.diagnostics().minuteUnits, 100);
  time = 62030;
  assert.equal(runtime.diagnostics().minuteUnits, 0);
  assert.equal(runtime.diagnostics().requestUnits, 100);
  runtime.dispose();
});

test("Gmail API charges the declared units and restricts metadata headers", async () => {
  const charges = [];
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return new Response(JSON.stringify(message("a1234567",
    "boss@example.com", ["INBOX", "UNREAD"], 42)), { status: 200 }); };
  const result = await api.message({ id: "a1234567", accessToken: "access", fetchImpl,
    reserve: units => { charges.push(units); return { allowed: true }; } });
  assert.equal(result.id, "a1234567");
  assert.deepEqual(charges, [20]);
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get("format"), "metadata");
  assert.deepEqual(url.searchParams.getAll("metadataHeaders"), ["From", "To", "Subject", "Message-ID"]);
});

test("OAuth consent times out even when launching the browser never settles", async () => {
  let openedUrl;
  await assert.rejects(api.authorize({
    client: { clientId: "123-test.apps.googleusercontent.com", clientSecret: "test-secret" },
    shell: { openExternal: url => { openedUrl = url; return new Promise(() => {}); } },
    timeoutMs: 25,
  }), { code: "auth-timeout" });
  assert.match(openedUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
});

test("runtime replays changes without losing an older priority row", async t => {
  const dir = fixture(t);
  const safeStorage = storage();
  const store = createMailStore({ dataDir: dir, safeStorage });
  store.saveAuth("worker@example.com", "refresh-secret");
  store.saveSettings({ senders: ["boss@example.com"], hidden: [] });
  store.saveCache({ account: "worker@example.com", historyId: "100", fetchedAt: 1000,
    nextPageToken: null, gap: false,
    rows: [core.normalizeMessage(message("a1234567", "boss@example.com", ["INBOX"], 900))] });
  let time = 500000;
  const fetchImpl = async (url, options) => {
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(options.body.get("refresh_token"), "refresh-secret");
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes("/history?")) return new Response(JSON.stringify({ historyId: "102",
      history: [{ messagesAdded: [{ message: { id: "b1234567" } }] }] }), { status: 200 });
    if (String(url).includes("/messages/b1234567")) return new Response(JSON.stringify(
      message("b1234567", "other@example.com", ["INBOX", "UNREAD"], 2000)), { status: 200 });
    throw new Error("unexpected URL: " + url);
  };
  const runtime = createMailRuntime({ dataDir: dir, safeStorage, shell: {}, fetchImpl, now: () => time });
  t.after(() => runtime.dispose());
  runtime.start();
  const result = await runtime.refresh(true);
  assert.deepEqual(result.priority.map(row => row.id), ["a1234567"]);
  assert.deepEqual(result.unread.map(row => row.id), ["b1234567"]);
  assert.equal(Object.hasOwn(result.priority[0], "url"), false);
  assert.equal(Object.hasOwn(result.unread[0], "url"), false);
  assert.equal(typeof runtime.link, "undefined");
  assert.equal(createMailStore({ dataDir: dir, safeStorage }).readCache("worker@example.com").historyId, "102");
  const held = await runtime.refresh(true);
  assert.equal(held.reason, "interval");
});

test("large history resumes from saved pending work without advancing the cursor early", async t => {
  const dir = fixture(t), safeStorage = storage();
  const store = createMailStore({ dataDir: dir, safeStorage });
  store.saveAuth("worker@example.com", "refresh-secret");
  store.saveCache({ account: "worker@example.com", historyId: "100", fetchedAt: 1000,
    nextPageToken: null, gap: false, rows: [] });
  let time = 500000, histories = 0;
  const ids = Array.from({ length: 80 }, (_, i) => `m${String(i).padStart(7, "0")}`);
  const fetchImpl = async url => {
    if (url === "https://oauth2.googleapis.com/token")
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    if (String(url).includes("/history?")) {
      histories++;
      return new Response(JSON.stringify({ historyId: "200", history: [{ messagesAdded:
        ids.map(id => ({ message: { id } })) }] }), { status: 200 });
    }
    const id = String(url).match(/\/messages\/(m\d{7})/)?.[1];
    if (id) return new Response(JSON.stringify(message(id, "other@example.com",
      ["INBOX", "UNREAD"], Number(id.slice(1)))), { status: 200 });
    throw new Error("unexpected URL");
  };
  const runtime = createMailRuntime({ dataDir: dir, safeStorage, shell: {}, fetchImpl, now: () => time });
  t.after(() => runtime.dispose());
  runtime.start();
  const first = await runtime.refresh(true);
  assert.equal(first.status, "partial");
  assert.equal(first.unread.length, 75);
  assert.equal(createMailStore({ dataDir: dir, safeStorage }).readCache("worker@example.com").historyId, "100");
  time += 61000;
  const second = await runtime.refresh(true);
  assert.equal(second.status, "ready");
  assert.equal(second.unread.length, 80);
  assert.equal(createMailStore({ dataDir: dir, safeStorage }).readCache("worker@example.com").historyId, "200");
  assert.equal(histories, 1);
});

test("disconnect during history fetch cannot restore the deleted mail cache", async t => {
  const dir = fixture(t), safeStorage = storage();
  const store = createMailStore({ dataDir: dir, safeStorage });
  store.saveAuth("worker@example.com", "refresh-secret");
  store.saveCache({ account: "worker@example.com", historyId: "100", fetchedAt: 1000,
    nextPageToken: null, gap: false, rows: [] });
  let release, seen;
  const started = new Promise(resolve => { seen = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const fetchImpl = async url => {
    if (url === "https://oauth2.googleapis.com/token")
      return new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }), { status: 200 });
    if (String(url).includes("/history?")) { seen(); await held;
      return new Response(JSON.stringify({ historyId: "200", history: [] }), { status: 200 }); }
    throw new Error("unexpected URL");
  };
  const runtime = createMailRuntime({ dataDir: dir, safeStorage, shell: {}, fetchImpl,
    now: () => 500000 });
  t.after(() => runtime.dispose());
  runtime.start();
  await started;
  assert.equal(runtime.disconnect().status, "unlinked");
  release();
  await runtime.refresh(true);
  assert.equal(fs.existsSync(path.join(dir, "cache.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "auth.json")), false);
  assert.equal(runtime.snapshot().status, "unlinked");
});
