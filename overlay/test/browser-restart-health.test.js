"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const health = require("../extensions/browser-bridge/restart-health");
const { validateClientHealth, validateDesktopBuild } = require("../src/browser-bridge-protocol");

function envelope(providers = health.unknownProviders()) {
  return { type: "client.health", v: 1, schema: 1, browserRunId: "run-health", workerEpoch: "worker-health",
    sequence: 1, extensionVersion: "0.1.8", observerVersion: "0.1.8", buildId: "b".repeat(64), observerContract: 1,
    providers, delivery: { state: "unknown", remainingReplay: null, livePending: null, reserveUsed: null } };
}

test("health inventory preserves unknown, known-empty, page refusal and the global admission bound", () => {
  const tabs = Array.from({ length: 23 }, (_, id) => ({ id, status: "complete",
    url: id % 2 ? `https://claude.ai/chat/private-${id}` : `https://chatgpt.com/c/private-${id}`,
    title: "PRIVATE_TITLE" }));
  const results = new Map(tabs.map(tab => [tab.id, { ok: tab.id !== 0, reason: "binding_unconfirmed" }]));
  const rows = health.summarize(tabs, results);
  const message = envelope(rows);
  assert.deepEqual(validateClientHealth(message), message);
  assert.equal(rows.reduce((sum, row) => sum + row.discovered, 0), 23);
  assert.equal(rows.reduce((sum, row) => sum + row.eligible, 0), 20);
  assert.equal(rows.reduce((sum, row) => sum + row.admitted, 0), 19);
  assert.equal(rows.reduce((sum, row) => sum + row.fresh, 0), 0);
  assert.equal(rows.reduce((sum, row) => sum + row.reasons.over_limit, 0), 3);
  assert.equal(rows[0].reasons.unconfirmed, 1);
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE_TITLE|private-|https:/);
  const hidden = health.summarize(tabs, results, { access: { chatgpt: false, claude: true } });
  assert.deepEqual(hidden[0], health.unknownProviders()[0]);
  assert.equal(hidden[1].inventory, "known");
  assert.equal(health.summarize([], new Map())[0].discovered, 0);
  assert.equal(health.unknownProviders()[0].discovered, null);
});

test("health wire schema rejects extra content, inconsistent counts and coerced version values", () => {
  for (const mutate of [
    value => { value.url = "https://chatgpt.com/c/private"; },
    value => { value.extensionVersion = ["0.1.8"]; },
    value => { value.observerVersion = 8; },
    value => { value.buildId = ["b".repeat(64)]; },
    value => { value.providers[0].discovered = 0; },
    value => { value.providers[1].provider = "chatgpt"; },
    value => { value.delivery.remainingReplay = 0; },
    value => { value.sequence = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const value = envelope(); mutate(value);
    assert.throws(() => validateClientHealth(value));
  }
  const known = envelope(health.summarize([{ id: 1, url: "https://claude.ai/chat/example" }], new Map()));
  known.providers[1].reasons.checking = 0;
  assert.throws(() => validateClientHealth(known));
});

test("capability negotiation keeps legacy ready frames usable and rejects malformed advertised builds", () => {
  assert.deepEqual(health.safePeer({ type: "ready" }), { capabilities: [], build: null });
  const build = { desktopVersion: "0.1.3-preview.1", buildId: "b".repeat(64), observerContract: 1 };
  assert.deepEqual(validateDesktopBuild(build), build);
  assert.deepEqual(health.safePeer({ capabilities: [health.CAPABILITY], build }).build, build);
  for (const malformed of [{ ...build, desktopVersion: 1 }, { ...build, buildId: [build.buildId] },
    { ...build, observerContract: 2 }, { ...build, path: "private" }]) {
    assert.throws(() => health.safePeer({ capabilities: [health.CAPABILITY], build: malformed }));
    assert.throws(() => validateDesktopBuild(malformed));
  }
});
