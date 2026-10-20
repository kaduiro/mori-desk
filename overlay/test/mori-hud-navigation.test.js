"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { createBrowserSessionStore, STALE_MS } = require("../src/browser-session-store");
const { mergeHudSnapshot } = require("../src/mori-desktop-snapshot");
const createBrowserWindowRuntime = require("../src/mori-browser-window");

// Exercise the shipped renderer, preload and IPC sender gate together. The DOM,
// Electron transport and final browser focus are fixtures, so this does not
// establish that Windows/macOS or a real Chrome window came to the foreground.
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
  click() {
    this.lastClickStopped = false;
    return this.listeners.get("click")?.({ stopPropagation: () => { this.lastClickStopped = true; } });
  }
}

function descendants(element) { return element.children.flatMap(child => [child, ...descendants(child)]); }

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mori-hud-navigation-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = Date.now();
  const store = createBrowserSessionStore({ dataDir, now: () => clock });
  store.connect("profile-1", "browser-run-1");
  let sequence = 0;
  function observe(patch = {}) {
    const eventSequence = ++sequence;
    store.ingest("profile-1", {
      type: "event", v: 1, eventId: `event-${eventSequence}`, sequence: eventSequence,
      browserRunId: "browser-run-1", sessionId: "session-1", provider: "chatgpt", tabId: 17,
      pageInstanceId: "page-1", routeRevision: 0, conversationRef: "/c/conversation-1",
      turnId: "turn-1", generation: 1, kind: "observation", phase: "running", outcome: null,
      observation: "fresh", observedAt: clock, replay: false, ...patch,
    });
  }
  const handlers = new Map();
  const preloadListeners = new Map();
  const calls = { focus: [], directAck: 0, legacy: [], panel: 0 };
  let focusResult = { ok: true };
  const src = path.join(__dirname, "..", "src");
  const hudPage = pathToFileURL(path.join(src, "session-hud.html")).toString();
  const mainFrame = { url: hudPage };
  const hud = { isDestroyed: () => false, webContents: { mainFrame } };
  let sender = { sender: hud.webContents, senderFrame: mainFrame };
  let panelWindow;
  class BrowserWindow {
    constructor() {
      calls.panel++;
      this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {}, send() {} };
      panelWindow = this;
    }
    isDestroyed() { return false; }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).toString(); }
    on() {}
    show() {}
    focus() {}
    destroy() {}
  }
  const runtime = createBrowserWindowRuntime({
    BrowserWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    clipboard: {}, shell: {}, getPort: () => 23333, getHudWindow: () => hud, cliEnabled: false,
    getBridge: () => ({
      getSnapshot: () => store.getSnapshot(),
      getStatus: () => ({ available: true, pairingAvailable: true, pairedClients: [{ clientId: "profile-1" }],
        connectedClients: [{ clientId: "profile-1", browserRunId: "browser-run-1" }] }),
      focus(id, noticeSequence) {
        const target = store.getFocusTarget(id, noticeSequence);
        calls.focus.push({ id, noticeSequence, target });
        return target ? focusResult : { ok: false, reason: "tab_unavailable" };
      },
      ack() { calls.directAck++; return { ok: true }; },
    }),
  });
  t.after(() => runtime.dispose());
  handlers.set("session-hud:get-i18n", async () => ({ lang: "ja", translations: {
    sessionFocusUnavailableWebui: "ローカルターミナルがありません",
  } }));
  handlers.set("session:ack-completion", async (_event, payload) => {
    calls.legacy.push({ channel: "session:ack-completion", payload });
    return { ok: true };
  });
  const root = new Element("div");
  const context = vm.createContext({
    document: { getElementById: () => root, createElement: tag => new Element(tag), querySelectorAll: () => [] },
    window: {}, setTimeout() {}, clearTimeout() {}, setInterval() {}, console,
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { context.window[name] = value; } },
        ipcRenderer: {
          on(channel, listener) { preloadListeners.set(channel, listener); },
          async invoke(channel, payload) {
            assert.ok(handlers.has(channel), `unexpected IPC invocation: ${channel}`);
            return handlers.get(channel)(sender, payload);
          },
          send(channel, payload) { calls.legacy.push({ channel, payload }); },
        },
      };
    },
  });
  for (const name of ["preload-session-hud.js", "session-focus-unavailable.js", "mori-hud-status.js", "session-hud-renderer.js"]) {
    vm.runInContext(fs.readFileSync(path.join(src, name), "utf8"), context, { filename: name });
  }
  await Promise.resolve();
  function publish() {
    const rows = store.getSnapshot();
    preloadListeners.get("session-hud:session-snapshot")({}, mergeHudSnapshot({
      sessions: [], orderedIds: [], hudTotalNonIdle: 0,
      hudPinned: true, accountQuota: [], moriBrowserStatus: { state: "ready", dnd: false },
    }, rows));
    return rows;
  }
  function rowElement() {
    const element = root.children.find(child => child.className.split(/\s+/).includes("row-browser"));
    assert.ok(element, "expected a rendered browser session row");
    return element;
  }
  function historyElement() {
    const element = root.children.find(child => child.className.split(/\s+/).includes("row-browser-history"));
    assert.ok(element, "expected a history details link instead of an old current-tab row");
    assert.equal(root.children.some(child => child.className.split(/\s+/).includes("row-browser")), false);
    return element;
  }
  return { store, calls, observe, publish, rowElement, historyElement, hud, mainFrame, hudPage, context,
    panelStatus() {
      assert.ok(panelWindow, "expected browser details to open");
      return handlers.get("mori:status")({ sender: panelWindow.webContents, senderFrame: panelWindow.webContents.mainFrame });
    },
    setFocusResult(value) { focusResult = value; },
    setSender(value) { sender = value; },
    advance(ms) { clock += ms; },
  };
}

test("clicking a connected row with stale DOM evidence reaches focus with its exact tab and captured notice", async t => {
  const f = await fixture(t);
  f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
  f.advance(STALE_MS + 1);
  const [row] = f.publish();
  assert.equal(row.status, "unknown");
  assert.equal(row.canFocus, true, "uncertain generation status does not itself block validated navigation");
  await f.rowElement().click();
  assert.equal(f.calls.focus.length, 1);
  const captured = f.calls.focus[0];
  assert.equal(captured.id, row.id);
  assert.equal(captured.noticeSequence, row.pendingNotice.noticeSequence);
  assert.equal(captured.target.tabId, 17);
  assert.equal(captured.target.pageInstanceId, "page-1");
  assert.equal(captured.target.conversationRef, "/c/conversation-1");
  assert.equal(f.calls.directAck, 0, "only the validated bridge focus result may acknowledge a browser receipt");
  assert.deepEqual(f.calls.legacy, [], "browser rows never call the CLI focus/ack path");
});

test("a generating row sends an explicit null notice; a later notice is not captured retroactively", async t => {
  const f = await fixture(t);
  f.observe();
  f.publish();
  let resolveFocus;
  f.setFocusResult(new Promise(resolve => { resolveFocus = resolve; }));
  const clicked = f.rowElement().click();
  assert.equal(f.calls.focus.length, 1);
  assert.equal(f.calls.focus[0].noticeSequence, null);
  f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
  const [next] = f.publish();
  resolveFocus({ ok: true });
  await clicked;
  assert.equal(f.calls.focus[0].noticeSequence, null);
  assert.equal(f.calls.directAck, 0);
  assert.equal(f.store.getSnapshot()[0].pendingNotice.noticeSequence, next.pendingNotice.noticeSequence);
  assert.equal(vm.runInContext(`unreadSessions.has(${JSON.stringify(next.id)})`, f.context), true);
});

test("a rejected browser focus keeps its unread receipt and never falls back to terminal navigation", async t => {
  const f = await fixture(t);
  f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
  const [row] = f.publish();
  f.setFocusResult({ ok: false, reason: "session_changed" });
  await f.rowElement().click();
  assert.equal(f.calls.focus.length, 1);
  assert.equal(f.store.getSnapshot()[0].pendingNotice.noticeSequence, row.pendingNotice.noticeSequence);
  assert.equal(vm.runInContext(`unreadSessions.has(${JSON.stringify(row.id)})`, f.context), true);
  assert.equal(f.calls.directAck, 0);
  assert.deepEqual(f.calls.legacy, []);
});

test("a disconnected retained record moves to the history link without issuing focus or acknowledging its receipt", async t => {
  const f = await fixture(t);
  f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
  f.store.disconnect("profile-1", "browser-run-1");
  const [row] = f.publish();
  assert.equal(row.canFocus, false);
  assert.equal(typeof row.focusUnavailableReason, "string");
  assert.equal(row.isHistory, true);
  assert.doesNotMatch(f.historyElement().title, /ターミナル|terminal/i);
  assert.match(f.historyElement().title, /未確認 1 件/);
  await f.historyElement().click();
  assert.equal(f.calls.focus.length, 0);
  assert.equal(f.calls.directAck, 0);
  assert.deepEqual(f.calls.legacy, []);
  assert.equal(f.store.getSnapshot()[0].pendingNotice.noticeSequence, row.pendingNotice.noticeSequence);
  assert.equal(f.calls.panel, 1, "the history link opens the retained record's details");
  assert.equal((await f.panelStatus()).selectedSessionId, row.id);
});

test("a connected row with unsupported generation controls can return to its validated tab", async t => {
  const f = await fixture(t);
  f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
  f.observe({ phase: "settled", outcome: "unverified", observation: "unsupported" });
  const [row] = f.publish();
  assert.equal(row.observation, "unsupported");
  assert.equal(row.canFocus, true);
  await f.rowElement().click();
  assert.equal(f.calls.focus.length, 1);
  const target = f.calls.focus[0].target;
  assert.equal(target.id, row.id);
  assert.equal(target.tabId, 17);
  assert.equal(target.pageInstanceId, "page-1");
  assert.equal(target.routeRevision, row.routeRevision);
  assert.equal(target.conversationRef, "/c/conversation-1");
  assert.equal(target.noticeSequence, row.pendingNotice.noticeSequence);
  assert.equal(f.calls.directAck, 0);
  assert.deepEqual(f.calls.legacy, []);
});

test("closed and older-browser-run records stay in history and select their retained details", async t => {
  for (const state of ["closed", "old-run"]) {
    const f = await fixture(t);
    f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
    if (state === "closed") {
      f.observe({ kind: "closed", phase: "settled", outcome: "unverified", observation: "closed" });
    } else {
      f.store.connect("profile-1", "browser-run-2");
    }
    const [row] = f.publish();
    assert.equal(row.canFocus, false, state);
    assert.equal(row.isHistory, true, state);
    await f.historyElement().click();
    assert.equal(f.calls.focus.length, 0, state);
    assert.equal(f.calls.directAck, 0, state);
    assert.deepEqual(f.calls.legacy, [], state);
    assert.equal(f.store.getSnapshot()[0].pendingNotice.noticeSequence, row.pendingNotice.noticeSequence, state);
    assert.equal((await f.panelStatus()).selectedSessionId, row.id, state);
  }
});

test("the details button selects this session without triggering row focus or any acknowledgement", async t => {
  const f = await fixture(t);
  f.observe({ kind: "terminal", phase: "settled", outcome: "unverified" });
  const [row] = f.publish();
  const button = descendants(f.rowElement()).find(element => element.className.split(/\s+/).includes("browser-details-button"));
  assert.ok(button, "each browser row offers its own details action");
  assert.equal(button.textContent, "詳細");
  await button.click();
  assert.equal(button.lastClickStopped, true, "details does not bubble into row navigation");
  assert.equal((await f.panelStatus()).selectedSessionId, row.id);
  assert.equal(f.calls.focus.length, 0);
  assert.equal(f.calls.directAck, 0);
  assert.deepEqual(f.calls.legacy, []);
  assert.equal(f.store.getSnapshot()[0].pendingNotice.noticeSequence, row.pendingNotice.noticeSequence);
});

test("the real focus IPC rejects other WebContents, subframes and a navigated HUD even with a valid row ID", async t => {
  const f = await fixture(t);
  f.observe();
  const [row] = f.publish();
  const impostorFrame = { url: f.hudPage };
  for (const sender of [
    { sender: { mainFrame: impostorFrame }, senderFrame: impostorFrame },
    { sender: f.hud.webContents, senderFrame: { url: f.hudPage } },
  ]) {
    f.setSender(sender);
    const result = await f.context.window.sessionHudAPI.focusBrowser(row.id, null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "untrusted-sender");
  }
  f.mainFrame.url = "https://example.invalid/";
  f.setSender({ sender: f.hud.webContents, senderFrame: f.mainFrame });
  const navigated = await f.context.window.sessionHudAPI.focusBrowser(row.id, null);
  assert.equal(navigated.reason, "untrusted-sender");
  assert.equal(f.calls.focus.length, 0);
});
