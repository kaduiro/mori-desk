"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getBrowserStatus } = require("../src/mori-browser-status");
const { mergeHudSnapshot } = require("../src/mori-desktop-snapshot");
const { getMoriHudStatus, getMoriHudHistory } = require("../src/mori-hud-status");

// Exercise the actual main-to-HUD projection, not an idealized replacement.
// Source-overlay runs read the last assembled main; final validation uses the
// newly reconstructed runtime's main. Electron itself is not started here.
const localMain = path.resolve(__dirname, "../src/main.js");
const mainPath = fs.existsSync(localMain) ? localMain : path.resolve(__dirname, "../../.runtime/src/main.js");
const mainSource = fs.readFileSync(mainPath, "utf8");
const projectHud = mainSource.match(/function getMoriHudSnapshot\(snapshot\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(projectHud, "the shipped main must define its local HUD projection");

function snapshot({ stale = false, hiddenClient = false } = {}) {
  const client = { clientId: "client", browserRunId: "run" };
  const bridge = { available: true, pairingAvailable: true, pairedClients: [client],
    connectedClients: [client], clientHealth: [{ ...client, state: stale ? "stale" : "current",
      health: { providers: ["chatgpt", "claude"].map(provider => ({ provider, inventory: "known",
        discovered: 1, admitted: 0, reasons: { unconfirmed: 1, unavailable: 0, over_limit: 0 } })) } }] };
  if (hiddenClient) bridge.connectedClients.push({ clientId: "unchecked", browserRunId: "another" });
  const base = { sessions: [], orderedIds: [] };
  const history = Array.from({ length: 6 }, (_, i) => ({ id: `old-${i}`, source: "browser",
    isHistory: true, isCurrent: false, unreadCount: i === 0 ? 2 : 0 }));
  return structuredClone(vm.runInNewContext(`(${projectHud})(input)`, {
    input: base, mergeHudSnapshot, getBrowserStatus,
    moriBridge: { getStatus: () => bridge, getSnapshot: () => history },
    moriProduct: { cliEnabled: false }, moriBoundPort: 23334,
    moriStartupError: "", moriListenerStatus: null, doNotDisturb: false,
  }));
}

test("HUD surfaces rejected conversation binding instead of a generic wait for observations", () => {
  const value = snapshot();
  const before = structuredClone(value);
  const notice = getMoriHudStatus(value);
  assert.match(notice.label, /ChatGPT.*Claude.*監視を保留/);
  assert.match(notice.detail, /会話の所属/);
  assert.match(notice.detail, /再接続だけでは解消しません/);
  assert.equal(getMoriHudHistory(value).label, "以前の記録 6 件 · 未確認 2 件");
  assert.deepEqual(Object.keys(value.moriBrowserStatus).sort(), ["dnd", "providers", "state"]);
  assert.deepEqual(value.moriBrowserStatus.providers, [
    { provider: "chatgpt", state: "unconfirmed" }, { provider: "claude", state: "unconfirmed" },
  ]);
  assert.deepEqual(value, before);
  assert.equal(getMoriHudStatus({ ...value, moriBrowserStatus: { ...value.moriBrowserStatus, dnd: true } }), null);
  assert.equal(getMoriHudStatus({ ...value, sessions: [{ id: "real-session" }] }), null);
});

test("stale and incomplete inventories cannot present a previous binding refusal as current", () => {
  for (const options of [{ stale: true }, { hiddenClient: true }]) {
    const notice = getMoriHudStatus(snapshot(options));
    assert.doesNotMatch(notice.label, /監視を保留/);
    assert.match(notice.label, /確認状況は不明/);
  }
});

test("HUD accepts provider names only from its allowlist", () => {
  const value = snapshot();
  value.moriBrowserStatus.providers = [{ provider: "private-title", state: "unconfirmed", name: "private-request" }];
  assert.equal(getMoriHudStatus(value).label, "生成状態は未受信");
  assert.doesNotMatch(JSON.stringify(getMoriHudStatus(value)), /private-/);
});

test('assembled main preserves v2 monitor counts for the HUD even alongside a session row', () => {
  const client={clientId:'client',browserRunId:'run'};
  const rows=['chatgpt','claude'].map((provider,i)=>({provider,inventory:'known',discovered:2,eligible:2,admitted:2,
    fresh:i?1:2,unmonitored:i?1:0,reasons:i?{scope_unconfirmed:1}:{}}));
  const bridge={available:true,pairedClients:[client],connectedClients:[client],clientHealth:[{...client,state:'current',health:{schema:2,providers:rows}}]};
  const value=structuredClone(vm.runInNewContext(`(${projectHud})(input)`,{input:{sessions:[],orderedIds:[]},
    mergeHudSnapshot,getBrowserStatus,moriBridge:{getStatus:()=>bridge,getSnapshot:()=>[]},moriProduct:{cliEnabled:false},
    moriBoundPort:23334,moriStartupError:'',moriListenerStatus:null,doNotDisturb:false}));
  assert.deepEqual(value.moriBrowserStatus.providers.map(r=>r.fresh),[2,1]);
  const notice=getMoriHudStatus({...value,sessions:[{id:'current-tab'}]});
  assert.match(notice.label,/ChatGPT 監視中2件.*Claude 監視中1件/);
  assert.match(notice.detail,/所属/);
  const unknown={...value,sessions:[{id:'known-tab'}],moriBrowserStatus:{...value.moriBrowserStatus,
    providers:[{provider:'chatgpt',state:'unknown'},{provider:'claude',state:'unknown'}]}};
  assert.match(getMoriHudStatus(unknown).label,/不明/);
});
