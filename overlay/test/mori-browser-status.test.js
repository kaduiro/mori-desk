"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getBrowserStatus } = require("../src/mori-browser-status");

function available(overrides = {}) {
  return { available: true, pairingAvailable: true, connectedClients: [], pairedClients: [], ...overrides };
}

test("desktop distinguishes startup, unpaired Chrome, and disconnected saved Chrome", () => {
  assert.equal(getBrowserStatus().state, "starting");
  const registered = available({ pairedClients: [{ clientId: "private-client" }] });
  assert.equal(getBrowserStatus({ bridge: registered }).state, "starting");
  const first = getBrowserStatus({ bridge: available(), port: 23334 });
  assert.equal(first.state, "pairing");
  assert.equal(first.port, 23334);
  assert.equal(first.canPair, true);
  assert.equal(getBrowserStatus({ bridge: registered, port: 23334 }).state, "disconnected");
});

test("authenticated socket is shown independently of missing DOM observations", () => {
  const bridge = available({ connectedClients: [{ clientId: "private-client", browserRunId: "private-run" }],
    pairedClients: [{ clientId: "private-client" }] });
  const result = getBrowserStatus({ bridge, port: 23335 });
  assert.equal(result.state, "ready");
  assert.equal(result.connectedCount, 1);
  assert.match(result.emptyText, /生成状態はまだ届いていません/);
  assert.match(result.label, /通信接続中/);
  assert.match(result.detail, /会話を監視できること/);
  assert.equal(result.providers.every(provider => provider.state === "unknown" && provider.discovered === null), true);
  assert.ok(!JSON.stringify(result).includes("private-client"));
  assert.ok(!JSON.stringify(result).includes("private-run"));
  assert.equal(Object.hasOwn(result, "sessions"), false);
});

test("failed secure storage and startup failure remain visible and cannot enable pairing", () => {
  for (const value of [
    { bridge: available({ available: false }), port: 23333 },
    { bridge: available({ pairingAvailable: false, error: "secure_storage_unavailable" }), port: 23334 },
    { error: "startup failure" },
  ]) {
    const result = getBrowserStatus(value);
    assert.equal(result.state, "unavailable");
    assert.equal(result.canPair, false);
  }
  assert.equal(getBrowserStatus({ bridge: available(), port: null }).canPair, false);
});

test("listener retry overrides a stale fallback port and never enables pairing", () => {
  for (const state of ["retry_wait", "binding", "disposed", "blocked"]) {
    const value = getBrowserStatus({ bridge: available(), port: 23333, listener: { state, port: null } });
    assert.equal(value.port, null);
    assert.equal(value.canPair, false);
  }
  assert.equal(getBrowserStatus({ listener: { state: "retry_wait", port: null } }).state, "retrying");
});

test("partial, old and expired provider reports never become a complete zero-tab inventory", () => {
  const current = { clientId: "first", browserRunId: "run-first" };
  const old = { clientId: "second", browserRunId: "run-second" };
  const health = { extensionVersion: "0.1.8", observerVersion: "0.1.8", providers: ["chatgpt", "claude"].map(provider => ({
    provider, inventory: "known", discovered: 0, admitted: 0, reasons: { unconfirmed: 0, unavailable: 0, over_limit: 0 },
  })), delivery: { state: "current", remainingReplay: 0, livePending: 0 } };
  const bridge = available({ connectedClients: [current], clientHealth: [{ ...current, state: "current", health }] });
  assert.equal(getBrowserStatus({ bridge, port: 23333 }).providers[0].state, "no_tabs");
  bridge.connectedClients.push(old);
  const partial = getBrowserStatus({ bridge, port: 23333 });
  assert.equal(partial.providers[0].state, "unknown");
  assert.equal(partial.providers[0].discovered, null);
  assert.equal(partial.delivery.state, "unknown");
  bridge.connectedClients.pop(); bridge.clientHealth[0].state = "stale";
  assert.equal(getBrowserStatus({ bridge, port: 23333 }).providers[0].discovered, null);
  bridge.connectedClients.length = 0;
  assert.equal(getBrowserStatus({ bridge, port: 23333 }).providers[0].discovered, null);
});

test("unconfirmed binding, pending new notifications and OS-disabled login stay distinct", () => {
  const client = { clientId: "private", browserRunId: "private-run" };
  const health = { extensionVersion: "0.1.8", observerVersion: "0.1.8", providers: [{ provider: "chatgpt", inventory: "known",
    discovered: 2, admitted: 0, reasons: { unconfirmed: 2, unavailable: 0, over_limit: 0 } }],
    delivery: { state: "current", remainingReplay: 0, livePending: 3 } };
  const bridge = available({ connectedClients: [client], clientHealth: [{ ...client, state: "current", health }] });
  const status = getBrowserStatus({ bridge, port: 23333, login: { state: "os_disabled" } });
  assert.equal(status.state, "ready");
  assert.equal(status.providers[0].state, "unconfirmed");
  assert.match(status.delivery.label, /3 件/);
  assert.equal(status.login.state, "os_disabled");
  assert.doesNotMatch(JSON.stringify(status), /private|監視復旧|F5/);
});
