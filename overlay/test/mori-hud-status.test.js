"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getMoriHudStatus } = require("../src/mori-hud-status");
const hud = require("../src/session-hud").__test;

function emptySnapshot(state, extra = {}) {
  return { sessions: [], orderedIds: [], hudTotalNonIdle: 0, accountQuota: [],
    moriBrowserStatus: { state, dnd: false }, ...extra };
}

test("empty browser HUD status describes connection evidence without creating a session", () => {
  const labels = {
    starting: "ブラウザ連携を準備中", pairing: "Chrome と接続", disconnected: "ブラウザ接続待ち",
    ready: "生成状態は未受信", unavailable: "接続状態を確認",
  };
  for (const [state, label] of Object.entries(labels)) {
    const snapshot = emptySnapshot(state);
    const before = structuredClone(snapshot);
    assert.equal(getMoriHudStatus(snapshot).label, label);
    assert.deepEqual(hud.computeHudLayout(snapshot), { expanded: [], folded: [], rowCount: 0 });
    assert.deepEqual(snapshot, before);
  }
  for (const snapshot of [null, {}, { sessions: [] }, emptySnapshot("unknown"), emptySnapshot("__proto__"),
    emptySnapshot("ready", { moriBrowserStatus: { state: "ready", dnd: true } }),
    emptySnapshot("ready", { sessions: [{ id: "kept", state: "idle", badge: "done" }] }),
    emptySnapshot("ready", { sessions: [{ id: "hidden", state: "sleeping" }] })]) {
    assert.equal(getMoriHudStatus(snapshot), null);
  }
});

test("empty browser help keeps HUD visibility gates and reserves only a one-row card", () => {
  const snapshot = emptySnapshot("pairing");
  const flags = { snapshot, sessionHudEnabled: true, sessionHudPinned: true, showQuota: false };
  assert.equal(hud.evaluateBaseEligible(flags), true);
  assert.equal(hud.evaluateShouldShow(flags).show, true);
  for (const gate of [{ sessionHudEnabled: false }, { petHidden: true },
    { miniMode: true }, { miniTransitioning: true },
    { snapshot: emptySnapshot("pairing", { moriBrowserStatus: { state: "pairing", dnd: true } }) }]) {
    assert.equal(hud.evaluateBaseEligible({ ...flags, ...gate }), false);
    assert.equal(hud.evaluateShouldShow({ ...flags, ...gate }).show, false);
  }
  assert.equal(hud.evaluateShouldShow({ ...flags, sessionHudPinned: false, clickRevealed: false }).show, false);
  assert.equal(hud.evaluateShouldShow({ ...flags, sessionHudPinned: false, clickRevealed: true, inHotZone: true }).show, true);
  assert.equal(hud.computeHudContentHeight(snapshot), hud.computeHudHeight(1));
  const geometry = hud.computeSessionHudBounds({
    hitRect: { left: 100, right: 200, top: 100, bottom: 200 },
    workArea: { x: 0, y: 0, width: 800, height: 600 },
    height: hud.computeHudContentHeight(snapshot), scale: 1.5,
  });
  assert.equal(geometry.contentBounds.height, Math.ceil(hud.computeHudHeight(1) * 1.5));
  assert.equal(geometry.contentBounds.y, 200 + Math.round(hud.constants.HUD_PET_GAP * 1.5));
  assert.equal(geometry.flippedAbove, false);
  const done = emptySnapshot("ready", { sessions: [{ id: "done", source: "browser", state: "idle", badge: "done" }] });
  assert.equal(hud.computeHudLayout(done).rowCount, 1, "completed sessions remain normal HUD rows");
  assert.equal(hud.computeHudContentHeight(done), hud.computeHudHeight(1));
});

// A small DOM fixture exercises the real renderer click handlers and receipt
// bookkeeping. It is not a Chrome/Electron/native-window validation.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.className = ""; this.textContent = ""; this.listeners = new Map();
    this.classList = { add: (...names) => { this.className += ` ${names.join(" ")}`; } };
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  click() { return this.listeners.get("click")?.({ stopPropagation() {} }); }
}

async function rendererFixture() {
  const root = new Element("div");
  const calls = { panel: 0, focus: 0, ack: 0, pinned: [] };
  let sendSnapshot;
  const context = vm.createContext({
    document: { getElementById: () => root, createElement: (tag) => new Element(tag), querySelectorAll: () => [] },
    window: { sessionHudAPI: {
      onLangChange() {}, onSessionSnapshot(callback) { sendSnapshot = callback; },
      getI18n: async () => ({ lang: "ja", translations: {} }),
      openBrowserPanel: async () => { calls.panel++; },
      focusSession: () => { calls.focus++; }, focusBrowser: async () => { calls.focus++; return { ok: true }; },
      ackCompletion: async () => { calls.ack++; }, ackBrowser: async () => { calls.ack++; },
      setPinned(value) { calls.pinned.push(value); },
    } },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, console,
  });
  for (const name of ["session-focus-unavailable.js", "mori-hud-status.js", "session-hud-renderer.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8"), context, { filename: name });
  }
  await Promise.resolve();
  return { root, calls, context, sendSnapshot };
}

function descendants(element) {
  return element.children.flatMap(child => [child, ...descendants(child)]);
}

test("empty HUD button opens browser connection help without focus, receipt ACK, or fake unread", async () => {
  const fixture = await rendererFixture();
  fixture.sendSnapshot(emptySnapshot("pairing", { hudPinned: true }));
  const button = fixture.root.children.find(child => child.className.includes("row-browser-status"));
  assert.ok(button);
  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.attributes["aria-label"], "Chrome と接続。ブラウザ連携画面を開く");
  assert.ok(descendants(button).some(child => child.textContent === "Chrome と接続"));
  await button.click();
  assert.equal(fixture.calls.panel, 1);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.ack, 0);
  assert.equal(vm.runInContext("unreadSessions.size", fixture.context), 0);
  assert.equal(vm.runInContext("snapshot.sessions.length", fixture.context), 0);
  assert.equal(vm.runInContext("snapshot.hudTotalNonIdle", fixture.context), 0);
  await fixture.root.children.find(child => child.className.includes("pin-btn")).click();
  assert.deepEqual(fixture.calls.pinned, [false]);
});

test("real browser rows replace empty help and preserve an unread receipt across a new turn", async () => {
  const fixture = await rendererFixture();
  fixture.sendSnapshot(emptySnapshot("ready"));
  assert.ok(descendants(fixture.root).some(child => child.textContent === "生成状態は未受信"));
  const row = { id: "browser:one", source: "browser", state: "idle", phase: "settled", badge: "done",
    outcome: "unverified", statusLabel: "回答を確認", canFocus: true, displayTitle: "ChatGPT 1",
    updatedAt: Date.now(), pendingNotice: { noticeSequence: 4 } };
  const current = emptySnapshot("ready", { sessions: [row], orderedIds: [row.id], hudTotalNonIdle: 1 });
  fixture.sendSnapshot(current);
  assert.equal(fixture.root.children.some(child => child.className.includes("row-browser-status")), false);
  assert.equal(vm.runInContext("unreadSessions.has('browser:one')", fixture.context), true);
  assert.ok(descendants(fixture.root).some(child => child.className.includes("unread-bell")));
  fixture.sendSnapshot({ ...current, sessions: [{ ...row, state: "working", phase: "running", badge: "running" }] });
  assert.equal(vm.runInContext("unreadSessions.has('browser:one')", fixture.context), true);
  assert.equal(fixture.calls.ack, 0);
  fixture.sendSnapshot(emptySnapshot("pairing", { moriBrowserStatus: { state: "pairing", dnd: true } }));
  assert.equal(fixture.root.children.length, 0, "DND does not display connection help");
});
