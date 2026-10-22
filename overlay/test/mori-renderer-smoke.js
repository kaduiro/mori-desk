"use strict";

// Run with the verified Electron binary after `npm run setup`, for example:
// .runtime/node_modules/.bin/electron --ozone-platform=headless \
//   .runtime/test/mori-renderer-smoke.js --output-dir=/absolute/test/output
// This checks real HTML/CSS/renderers with an isolated store and synthetic IPC.
// It does not validate native window focus, safeStorage, or an installed Chrome.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createBrowserSessionStore } = require("../src/browser-session-store");
const { mergeHudSnapshot } = require("../src/mori-desktop-snapshot");
const { __test: hudGeometry } = require("../src/session-hud");

const ownedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-renderer-smoke-"));
const outputArgument = process.argv.find(arg => arg.startsWith("--output-dir="));
const outputDirectory = outputArgument ? path.resolve(outputArgument.slice("--output-dir=".length)) : ownedDirectory;
fs.mkdirSync(outputDirectory, { recursive: true });
app.setPath("userData", path.join(ownedDirectory, "profile"));
app.disableHardwareAcceleration();
const errors = [];
const calls = [];
let panel;
let hud;
let selectedSessionId = null;
let selectionRevision = 0;
let showElapsed = true;
let showStateLabels = true;
const store = createBrowserSessionStore({ dataDir: path.join(ownedDirectory, "browser-store") });
const clientId = "renderer-smoke-client";
const currentRun = "renderer-current-run";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(description, check) {
  const end = Date.now() + 5000;
  do { if (await check()) return; await pause(25); } while (Date.now() < end);
  throw new Error(`Renderer smoke did not observe: ${description}`);
}
function event(number, sequence, overrides = {}) {
  return { type: "event", v: 1, eventId: `renderer-event-${number}-${sequence}`,
    browserRunId: currentRun, sessionId: `renderer-session-${number}`, sequence,
    kind: "observation", provider: "chatgpt", tabId: number, pageInstanceId: `renderer-page-${number}`,
    routeRevision: 0, conversationRef: `/c/renderer-conversation-${number}`, turnId: null, generation: 0,
    phase: "idle", outcome: null, observation: "fresh", observedAt: Date.now(), replay: false,
    conversationTitle: "", requestPreview: "", ...overrides };
}
function snapshot() {
  return { ...mergeHudSnapshot({ sessions: [], orderedIds: [] }, store.getSnapshot()),
    hudShowStateLabels: showStateLabels, hudShowElapsed: showElapsed,
    hudShowContextUsage: false, hudPinned: false, accountQuota: [],
    moriBrowserStatus: { state: "ready", dnd: false } };
}
function status() {
  return { sessions: store.getSnapshot(), selectedSessionId, selectionRevision, cliEnabled: false,
    connection: { state: "ready", label: "Chrome と接続中", canPair: true,
      detail: "テスト用の会話で、現在のタブと以前の記録の表示を確認しています。" },
    bridge: { connectedClients: [], pairedClients: [] } };
}
function publish() {
  panel?.webContents.send("mori-smoke-change");
  hud?.webContents.send("mori-smoke-snapshot", snapshot());
}
ipcMain.handle("mori-renderer-smoke", (_event, operation, ...args) => {
  if (operation === "status") return status();
  if (operation === "select") { selectedSessionId = args[0]; selectionRevision++; publish(); return { ok: true }; }
  if (["setLabel", "ack", "dismiss"].includes(operation)) {
    const result = store[operation](...args); publish(); return result;
  }
  calls.push({ operation, args });
  return { ok: true };
});
function createWindow(width, height) {
  const window = new BrowserWindow({ show: false, frame: false, width, height,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, "fixtures/mori-renderer-smoke-preload.js") } });
  window.webContents.on("preload-error", (_event, _file, error) => errors.push(error.message));
  window.webContents.on("render-process-gone", (_event, details) => errors.push(details.reason));
  window.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") errors.push(details.message);
  });
  return window;
}
function sizeHud() {
  const { top, bottom, left, right } = hudGeometry.constants.HUD_WINDOW_SHELL;
  const value = snapshot();
  hud.setContentSize(hudGeometry.getHudWidth(showElapsed, showStateLabels, false) + left + right,
    hudGeometry.computeHudContentHeight(value, { showStateLabels }) + top + bottom);
  publish();
}
async function geometry() {
  return hud.webContents.executeJavaScript(`(() => {
    const rect = element => { const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height }; };
    return { viewport: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
      rows: [...document.querySelectorAll('.row-browser')].map(row => {
        const button = row.querySelector('.browser-details-button');
        const buttonRect = rect(button);
        const hit = document.elementFromPoint((buttonRect.left + buttonRect.right) / 2,
          (buttonRect.top + buttonRect.bottom) / 2);
        return { row: rect(row), button: buttonRect, hit: button.contains(hit),
          title: row.querySelector('.title').textContent,
          preview: row.querySelector('.browser-request-preview')?.textContent || '' };
      }), history: rect(document.querySelector('.row-browser-history')) };
  })()`);
}
function inside(inner, outer) {
  return inner.width > 0 && inner.height > 0 && inner.left >= outer.left - 1 && inner.top >= outer.top - 1
    && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
}
async function screenshot(window, name) {
  const [width, height] = window.getContentSize();
  assert.ok(width >= 190 && height >= 64, "offscreen window must have a usable viewport");
  window.webContents.invalidate();
  await pause(100);
  const capture = await window.webContents.capturePage({ x: 0, y: 0, width, height });
  assert.equal(capture.isEmpty(), false, "offscreen capture must contain rendered pixels");
  assert.deepEqual(capture.getSize(), { width, height }, "capture must contain the full tested viewport");
  fs.writeFileSync(path.join(outputDirectory, name), capture.toPNG());
}
const deadline = setTimeout(() => { console.error("Renderer smoke timed out"); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  store.connect(clientId, "renderer-old-run");
  const archived = store.ingest(clientId, event(3, 1, { browserRunId: "renderer-old-run", kind: "terminal",
    phase: "settled", turnId: "renderer-old-turn", generation: 1, outcome: "unverified",
    conversationTitle: "以前の議事録", requestPreview: "前回の議事録から決定事項を整理してください。" }));
  store.connect(clientId, currentRun);
  const first = store.ingest(clientId, event(1, 1, { conversationTitle: "長期インターンの目標を考える",
    requestPreview: "社員の方の助言を踏まえ、今週から始められる行動を整理してください。" }));
  const second = store.ingest(clientId, event(2, 1, { provider: "claude", conversationRef: "/chat/renderer-proposal",
    conversationTitle: "新規サービスの企画書", requestPreview: "対象ユーザーの困りごとと提案の構成を見直してください。" }));
  panel = createWindow(880, 1400);
  hud = createWindow(320, 200);
  await Promise.all([panel.loadFile(path.join(__dirname, "../src/mori-browser.html")),
    hud.loadFile(path.join(__dirname, "../src/session-hud.html"))]);
  // Headless Ozone may initially allocate a hidden window as 1x1; explicitly
  // size the isolated windows after the renderer has been attached.
  panel.setContentSize(880, 1400);
  sizeHud();
  await until("two current cards and one collapsed history", () => panel.webContents.executeJavaScript(
    "document.querySelectorAll('#sessions>.session').length===2 && document.querySelectorAll('#history-sessions>.session').length===1 && !document.getElementById('history').open"));
  assert.equal(await panel.webContents.executeJavaScript("document.getElementById('count').textContent"), "2 件");
  assert.equal(await panel.webContents.executeJavaScript("document.getElementById('history-unread').textContent"), "未確認 1 件");
  await until("two current HUD rows with previews", () => hud.webContents.executeJavaScript(
    "document.querySelectorAll('.row-browser').length===2 && document.querySelectorAll('.browser-request-preview').length===2"));
  const measurements = [];
  for (const labels of [true, false]) for (const elapsed of [true, false]) {
    showStateLabels = labels; showElapsed = elapsed; sizeHud();
    await pause(80);
    const measured = await geometry(); measurements.push({ labels, elapsed, ...measured });
    assert.deepEqual(measured.rows.map(row => row.title).sort(), ["新規サービスの企画書", "長期インターンの目標を考える"].sort());
    assert.equal(measured.rows.find(row => row.title === "長期インターンの目標を考える").preview,
      "依頼：社員の方の助言を踏まえ、今週から始められる行動を整理してください。");
    for (const row of measured.rows) {
      assert.equal(row.row.height, 66);
      assert.ok(inside(row.button, row.row) && inside(row.button, measured.viewport) && row.hit,
        `HUD details must stay clickable: ${JSON.stringify({ labels, elapsed, row })}`);
    }
    assert.ok(inside(measured.history, measured.viewport), "history entry must fit the calculated HUD height");
  }
  showStateLabels = true; showElapsed = true; sizeHud(); await pause(80);
  await screenshot(hud, "hud-current-and-history.png");
  await screenshot(panel, "panel-current-and-history.png");
  console.log("PASS: current/history counts, collapsed history, title/preview rendering, four HUD width settings and calculated row heights.");

  const firstMetadata = { conversationTitle: "長期インターンの目標を考える",
    requestPreview: "社員の方の助言を踏まえ、今週から始められる行動を整理してください。" };
  store.ingest(clientId, event(1, 2, { ...firstMetadata, phase: "running", turnId: "renderer-new-turn", generation: 1 }));
  store.ingest(clientId, event(1, 3, { ...firstMetadata, kind: "terminal", phase: "settled", turnId: "renderer-new-turn",
    generation: 1, outcome: "unverified" }));
  store.connect(clientId, currentRun);
  for (const labels of [true, false]) for (const elapsed of [true, false]) {
    showStateLabels = labels; showElapsed = elapsed; sizeHud(); await pause(80);
    const measured = await geometry(); measurements.push({ scenario: "stale-current-with-unread", labels, elapsed, ...measured });
    for (const row of measured.rows) assert.ok(inside(row.button, row.row) && inside(row.button, measured.viewport) && row.hit,
      `Stale/unread HUD details must stay clickable: ${JSON.stringify({ labels, elapsed, row })}`);
  }
  showStateLabels = true; showElapsed = true; sizeHud(); await pause(80);
  console.log("PASS: long stale status and an unread receipt preserve clickable HUD details at all four width settings.");

  await hud.webContents.executeJavaScript("document.querySelector('.row-browser-history').click()");
  await until("history entry selects and expands its unread card", () => panel.webContents.executeJavaScript(
    "document.getElementById('history').open && document.querySelector('#history-sessions .session-selected .session-name')?.textContent === '以前の議事録'"));
  assert.equal(selectedSessionId, archived.id);
  await screenshot(panel, "panel-selected-history.png");
  await hud.webContents.executeJavaScript(`(() => { const buttons = [...document.querySelectorAll('.browser-details-button')];
    buttons.find(button => button.getAttribute('aria-label') === '長期インターンの目標を考える の詳細').click(); })()`);
  await until("current details selected", () => panel.webContents.executeJavaScript(
    "document.querySelector('#sessions .session-selected .session-name')?.textContent === '長期インターンの目標を考える'"));
  assert.equal(selectedSessionId, first.id);
  await panel.webContents.executeJavaScript(`(() => { const input = document.querySelector('.session-selected .session-label-input');
    window.smokeEditedInput = input; input.focus(); input.value = '目標を入力途中';
    input.dispatchEvent(new Event('compositionstart')); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  store.connect(clientId, currentRun); publish();
  await pause(80);
  assert.equal(await panel.webContents.executeJavaScript(
    "document.activeElement === window.smokeEditedInput && window.smokeEditedInput.value === '目標を入力途中'"), true);
  store.disconnect(clientId, currentRun); publish(); await pause(80);
  assert.equal(await panel.webContents.executeJavaScript(
    "document.activeElement === window.smokeEditedInput && window.smokeEditedInput.isConnected && window.smokeEditedInput.value === '目標を入力途中'"), true);
  await panel.webContents.executeJavaScript("window.smokeEditedInput.dispatchEvent(new Event('compositionend')); window.smokeEditedInput.blur()");
  await until("completed editing permits moving cards into history", () => panel.webContents.executeJavaScript(
    "document.querySelectorAll('#sessions>.session').length===0 && document.querySelectorAll('#history-sessions>.session').length===3"));
  assert.equal(await panel.webContents.executeJavaScript("window.smokeEditedInput.value"), "目標を入力途中");
  assert.equal(store.getSnapshot().find(row => row.id === archived.id).unreadCount, 1);
  assert.equal(calls.some(call => call.operation === "focus"), false, "details and history must not focus or ACK a browser tab");
  assert.ok(store.getSnapshot().find(row => row.id === second.id).isHistory);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(outputDirectory, "renderer-measurements.json"), JSON.stringify(measurements, null, 2));
  console.log("PASS: history/detail selection, preserved unread, and input/IME continuity across reconnect and current-to-history migration.");
  console.log(`Synthetic Electron renderer screenshots: ${outputDirectory}`);
  clearTimeout(deadline); app.quit();
}).catch(error => { clearTimeout(deadline); console.error(error.stack || error.message); app.exit(1); });
