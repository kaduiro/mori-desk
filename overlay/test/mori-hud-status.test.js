"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getMoriHudStatus, getMoriHudHistory, getMoriBrowserRowHeight } = require("../src/mori-hud-status");
const { mergeHudSnapshot } = require("../src/mori-desktop-snapshot");
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
  assert.equal(hud.computeHudContentHeight(done), hud.computeHudHeight(1) + 20);
});

test("current browser content and the explicit history link reserve their own heights without changing CLI rows", () => {
  const cli = { id: "cli", state: "idle", badge: "done" };
  const first = { id: "browser:one", source: "browser", isCurrent: true, state: "working", requestPreview: "最初の依頼" };
  const second = { id: "browser:two", source: "browser", isCurrent: true, state: "idle" };
  const previous = { id: "browser:old", source: "browser", isHistory: true, isCurrent: false, state: "idle", unreadCount: 2 };
  const mixed = mergeHudSnapshot(emptySnapshot("ready", { sessions: [cli], orderedIds: [cli.id] }), [first, second, previous]);
  assert.equal(getMoriBrowserRowHeight(cli), 28);
  assert.equal(getMoriBrowserRowHeight(first), 66);
  assert.equal(getMoriBrowserRowHeight(second), 48);
  assert.equal(hud.computeHudLayout(mixed).rowCount, 3);
  assert.equal(hud.computeHudContentHeight(mixed), hud.computeHudHeight(4) + 38 + 20);
  assert.equal(getMoriHudHistory(mixed).label, "以前の記録 1 件 · 未確認 2 件");
  assert.equal(getMoriHudHistory(mixed).sessionId, previous.id);
  const onlyHistory = mergeHudSnapshot(emptySnapshot("disconnected"), [previous]);
  assert.equal(hud.computeHudLayout(onlyHistory).rowCount, 0);
  assert.equal(hud.computeHudContentHeight(onlyHistory), hud.computeHudHeight(2), "Connection status and history are independent notices");
  assert.equal(hud.evaluateBaseEligible({ snapshot: onlyHistory, sessionHudEnabled: true, showQuota: false }), true);
  const dnd = { ...onlyHistory, moriBrowserStatus: { state: "disconnected", dnd: true } };
  assert.equal(getMoriHudHistory(dnd), null);
  assert.equal(hud.evaluateBaseEligible({ snapshot: dnd, sessionHudEnabled: true, showQuota: false }), false);
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
  const calls = { panel: 0, panelIds: [], focus: 0, ack: 0, pinned: [] };
  let sendSnapshot;
  const context = vm.createContext({
    document: { getElementById: () => root, createElement: (tag) => new Element(tag), querySelectorAll: () => [] },
    window: { sessionHudAPI: {
      onLangChange() {}, onSessionSnapshot(callback) { sendSnapshot = callback; },
      getI18n: async () => ({ lang: "ja", translations: {} }),
      openBrowserPanel: async id => { calls.panel++; calls.panelIds.push(id); },
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

test("HUD titles and submitted previews update as inert text while history stays an explicit details link", async () => {
  const fixture = await rendererFixture();
  const unsafe = '<img src="x" onerror="unexpected()">';
  const first = { id: "browser:one", source: "browser", isCurrent: true, state: "working", badge: "running", label: "ChatGPT 1", displayTitle: "長期インターンの考え方", conversationTitle: "長期インターンの考え方", requestPreview: "何から始めればいいですか", canFocus: true };
  const second = { ...first, id: "browser:two", label: "ChatGPT 2", displayTitle: "セッション表示の改善", conversationTitle: "セッション表示の改善", requestPreview: unsafe };
  const previous = { ...first, id: "browser:old", isCurrent: false, isHistory: true, displayTitle: "古いセッション", unreadCount: 2, pendingNotice: { noticeSequence: 8 } };
  const snapshot = mergeHudSnapshot(emptySnapshot("ready"), [first, second, previous]);
  fixture.sendSnapshot(snapshot);
  const rows = fixture.root.children.filter(child => child.className.split(/\s+/).includes("row-browser"));
  assert.equal(rows.length, 2);
  assert.ok(descendants(rows[0]).some(child => child.textContent === first.displayTitle), "Japanese title is no longer manually shortened to a few characters");
  assert.ok(descendants(rows[1]).some(child => child.textContent === `依頼：${unsafe}`));
  assert.equal(descendants(fixture.root).some(child => child.tagName === "IMG"), false);
  assert.equal(descendants(fixture.root).some(child => child.textContent === "古いセッション"), false);
  const history = fixture.root.children.find(child => child.className.includes("row-browser-history"));
  assert.ok(history);
  assert.match(history.attributes["aria-label"], /以前の記録 1 件 · 未確認 2 件/);
  await history.click();
  assert.deepEqual(fixture.calls.panelIds, [previous.id]);
  assert.equal(fixture.calls.focus, 0);
  assert.equal(fixture.calls.ack, 0);
  assert.equal(vm.runInContext("unreadSessions.has('browser:old')", fixture.context), false, "History unread state is separate from the current session list");
  fixture.sendSnapshot(mergeHudSnapshot(emptySnapshot("ready"), [{ ...first, displayTitle: "移動先の会話", conversationTitle: "移動先の会話", requestPreview: "更新後の依頼" }, second, previous]));
  assert.ok(descendants(fixture.root).some(child => child.textContent === "移動先の会話"));
  assert.ok(descendants(fixture.root).some(child => child.textContent === "依頼：更新後の依頼"));
  assert.equal(descendants(fixture.root).some(child => child.textContent === first.displayTitle), false);
});
