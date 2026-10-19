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
  assert.match(result.detail, /表示されない原因を確認/);
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
