"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { WebSocket } = require("ws");
const { app, BrowserWindow } = require("electron");
const { EXTENSION_ID, mac, verifyMac, validateEvent } = require("../src/browser-bridge-protocol");
const rendererErrors = [];
let browserFixture = null;
if (process.platform !== "win32" || !process.env.MORI_DESK_TEST_DATA_DIR) {
  throw new Error("Run through scripts/smoke-windows-ui.js with an owned Windows profile.");
}
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => rendererErrors.push(`preload: ${error.message}`));
  contents.on("render-process-gone", (_event, details) => rendererErrors.push(`renderer: ${details.reason}`));
});

// Load the real composition root, including safeStorage, the HUD owner, the
// browser panel and their sandboxed preloads. A synthetic client below talks
// to this process's real loopback bridge; it is not an installed Chrome tab.
// Electron's direct JavaScript entry sets appPath to this test directory.
// Establish the same package root/version as a normal runtime launch before
// main performs its full source/build checks; do not bypass those checks.
app.setAppPath(path.resolve(__dirname, ".."));
app.setVersion(require("../package.json").version);
require("../src/main");

const timeout = setTimeout(() => {
  console.error("Native UI smoke timed out while waiting for Mori windows.");
  app.exit(1);
}, 45000);
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function bounded(promise, description, milliseconds = 3000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Native UI smoke timed out: ${description}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
async function until(description, check, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  do {
    const result = await check();
    if (result) return result;
    await delay(50);
  } while (Date.now() < end);
  throw new Error(`Native UI smoke did not observe: ${description}`);
}
async function findWindow(file) {
  for (let count = 0; count < 100; count++) {
    const candidate = BrowserWindow.getAllWindows().find(win =>
      !win.isDestroyed() && win.webContents.getURL().endsWith(`/${file}`)
      && !win.webContents.isLoading());
    if (candidate) return candidate;
    await delay(200);
  }
  throw new Error(`Mori window did not load: ${file}`);
}

function hudRow(title) {
  // The full accessible label survives CSS ellipsis in the visible title.
  return `[...document.querySelectorAll('.row-browser')].find(row => row.querySelector('.browser-details-button')?.getAttribute('aria-label') === ${JSON.stringify(`${title} の詳細`)})`;
}
async function clickHud(hud, title, details = false) {
  return hud.webContents.executeJavaScript(`(() => {
    const row = ${hudRow(title)};
    if (!row) throw new Error('Expected browser HUD row is missing');
    const target = ${details ? "row.querySelector('.browser-details-button')" : "row"};
    if (!target) throw new Error('Expected browser HUD action is missing');
    target.click(); return true;
  })()`);
}
function inside(inner, outer) {
  return inner.width > 0 && inner.height > 0 && inner.left >= outer.left - 1
    && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
}
async function assertDetailsGeometry(hud, title) {
  let geometry = null;
  try {
    await until("HUD details button fits its row and native viewport", async () => {
      geometry = await hud.webContents.executeJavaScript(`(() => {
        const row = ${hudRow(title)};
        const button = row?.querySelector('.browser-details-button');
        if (!button) return null;
        const rect = element => { const r = element.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const buttonRect = rect(button);
        const hit = document.elementFromPoint((buttonRect.left + buttonRect.right) / 2,
          (buttonRect.top + buttonRect.bottom) / 2);
        return { row: rect(row), button: buttonRect, hit: button.contains(hit), viewport: { left: 0, top: 0,
          right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight } };
      })()`);
      return geometry && geometry.hit && inside(geometry.button, geometry.row) && inside(geometry.button, geometry.viewport);
    }, 3000);
  } catch (error) {
    error.message += `; measured geometry: ${JSON.stringify(geometry)}`;
    throw error;
  }
  assert.ok(inside(geometry.button, geometry.row));
  assert.ok(inside(geometry.button, geometry.viewport));
  assert.equal(geometry.hit, true, "the details button center must not be clipped or covered by another HUD element");
}
async function closePanel(panel) {
  panel.close();
  await until("browser panel closed", () => panel.isDestroyed());
}
async function panelRow(panel, sessionId, predicate = () => true) {
  return until(`browser session ${sessionId}`, async () => {
    const state = await panel.webContents.executeJavaScript("window.mori.status()");
    const row = state.sessions.find(item => item.sessionId === sessionId);
    return row && predicate(row) ? row : false;
  });
}

async function pairFixtureThroughPanel(panel, expectedPort) {
  await panel.webContents.executeJavaScript("document.getElementById('pair').click()");
  const code = await until("pairing code issued by the real panel", async () => {
    const value = await panel.webContents.executeJavaScript("document.getElementById('code').value");
    return value.startsWith("mori1:") ? value : false;
  });
  const pairing = JSON.parse(Buffer.from(code.slice(6), "base64url").toString("utf8"));
  assert.equal(pairing.port, expectedPort);
  assert.equal(pairing.productId, "mori-desk");
  const socket = new WebSocket(`ws://127.0.0.1:${expectedPort}/browser/v1`, {
    origin: `chrome-extension://${EXTENSION_ID}`,
  });
  const queued = [];
  const waiting = [];
  const frames = [];
  let failure = null;
  const fail = error => {
    failure ||= error;
    for (const wait of waiting.splice(0)) { clearTimeout(wait.timer); wait.reject(failure); }
  };
  const send = message => socket.send(JSON.stringify(message));
  socket.on("error", () => fail(new Error("Synthetic browser's loopback socket failed")));
  socket.on("close", () => fail(new Error("Synthetic browser's loopback socket closed")));
  socket.on("message", data => {
    try {
      const message = JSON.parse(data.toString("utf8"));
      frames.push(message);
      if (message.type === "ping") { send({ type: "pong", at: message.at }); return; }
      if (message.type === "error") { fail(new Error(`Synthetic browser was refused: ${message.code}`)); return; }
      const index = waiting.findIndex(wait => wait.type === message.type);
      if (index < 0) queued.push(message);
      else {
        const [wait] = waiting.splice(index, 1);
        clearTimeout(wait.timer); wait.resolve(message);
      }
    } catch { fail(new Error("Synthetic browser received an invalid protocol frame")); }
  });
  const take = type => {
    if (failure) return Promise.reject(failure);
    const index = queued.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const wait = { type, resolve, reject, timer: null };
      wait.timer = setTimeout(() => {
        const pendingIndex = waiting.indexOf(wait);
        if (pendingIndex >= 0) waiting.splice(pendingIndex, 1);
        reject(new Error(`Synthetic browser did not receive ${type}`));
      }, 3000);
      waiting.push(wait);
    });
  };
  const client = { socket, send, take, frames, clientId: "native-smoke-client", browserRunId: "native-smoke-run" };
  browserFixture = client;
  await bounded(new Promise((resolve, reject) => {
    socket.once("open", resolve); socket.once("error", reject);
  }), "open the synthetic browser's loopback socket");
  const nonce = crypto.randomBytes(32).toString("base64url");
  send({ type: "hello", v: 1, mode: "pair", clientId: client.clientId, browserRunId: client.browserRunId,
    instanceId: pairing.instanceId, credentialId: pairing.pairingId, clientNonce: nonce });
  const challenge = await take("challenge");
  assert.equal(challenge.port, expectedPort);
  assert.equal(challenge.instanceId, pairing.instanceId);
  assert.equal(challenge.clientId, client.clientId);
  assert.equal(challenge.clientNonce, nonce);
  assert.equal(verifyMac(challenge.proof, pairing.secret, "server-proof", challenge), true);
  send({ type: "authenticate", proof: mac(pairing.secret, "client-proof", challenge) });
  const pending = await take("pair.ready");
  assert.equal(pending.clientId, client.clientId);
  const key = mac(pairing.secret, "credential", challenge);
  send({ type: "pair.confirm", proof: mac(key, "pair-confirm", challenge) });
  const ready = await take("ready");
  assert.equal(ready.instanceId, pairing.instanceId);
  assert.equal(ready.serverRunId, challenge.serverRunId);
  return client;
}

function fixtureEvent(sessionNumber, sequence, overrides = {}) {
  return validateEvent({ type: "event", v: 1, eventId: `native-event-${sessionNumber}-${sequence}`,
    browserRunId: "native-smoke-run", sessionId: `native-session-${sessionNumber}`, sequence,
    kind: "observation", provider: "chatgpt", tabId: sessionNumber,
    pageInstanceId: `native-document-${sessionNumber}`, routeRevision: 0,
    conversationRef: `/c/native-conversation-${sessionNumber}`, turnId: `native-turn-${sessionNumber}`, generation: 1,
    phase: "running", outcome: null, observation: "fresh", observedAt: Date.now(), replay: false, ...overrides });
}
async function deliverFixture(client, message) {
  client.send(message);
  const receipt = await client.take("event.ack");
  for (const key of ["eventId", "browserRunId", "sessionId", "sequence"]) assert.equal(receipt[key], message[key]);
}

app.whenReady().then(async () => {
  const panel = await findWindow("mori-browser.html");
  const hud = await findWindow("session-hud.html");
  // Rendering and the initial IPC snapshot settle after did-finish-load.
  let label = "";
  for (let count = 0; count < 30; count++) {
    label = await hud.webContents.executeJavaScript("document.querySelector('.row-browser-status .title')?.textContent || ''");
    if (label === "Chrome と接続") break;
    await delay(100);
  }
  assert.equal(label, "Chrome と接続");
  assert.equal(hud.isVisible(), true);
  const status = await panel.webContents.executeJavaScript("window.mori.status()");
  assert.equal(status.connection.state, "pairing");
  assert.equal(status.connection.canPair, true, "real Windows safeStorage must allow pairing in this check");
  assert.equal(status.sessions.length, 0);
  assert.equal(status.cliEnabled, false);
  assert.ok(status.port >= 23333 && status.port <= 23337);

  await closePanel(panel);
  await hud.webContents.executeJavaScript("document.querySelector('.row-browser-status').click()");
  let reopened = await findWindow("mori-browser.html");
  assert.equal(reopened.isVisible(), true);
  console.log("PASS: native Windows main, protected key storage, empty HUD, and HUD-to-panel IPC.");

  const client = await pairFixtureThroughPanel(reopened, status.port);
  const firstMetadata = { conversationTitle: "長期インターンの目標", requestPreview: "今週から始められる行動を整理してください。" };
  const secondMetadata = { conversationTitle: "企画会議の議事録", requestPreview: "会議で決まったことと次の担当作業を整理してください。" };
  await deliverFixture(client, fixtureEvent(1, 1, firstMetadata));
  const first = await panelRow(reopened, "native-session-1", row => row.status === "generating");
  await until("one populated HUD row", () => hud.webContents.executeJavaScript("document.querySelectorAll('.row-browser').length === 1"));
  await assertDetailsGeometry(hud, first.displayTitle);
  await deliverFixture(client, fixtureEvent(2, 1, secondMetadata));
  const second = await panelRow(reopened, "native-session-2", row => row.status === "generating");
  assert.equal(first.canFocus, true);
  assert.equal(second.canFocus, true);
  await until("two populated HUD rows with details actions", () => hud.webContents.executeJavaScript(
    "document.querySelectorAll('.row-browser').length === 2 && document.querySelectorAll('.browser-details-button').length === 2"));
  for (const [row, metadata] of [[first, firstMetadata], [second, secondMetadata]]) {
    assert.equal(row.displayTitle, metadata.conversationTitle);
    assert.equal(row.conversationTitle, metadata.conversationTitle);
    assert.equal(row.requestPreview, metadata.requestPreview);
    await until("HUD conversation title and submitted request excerpt", () => hud.webContents.executeJavaScript(`(() => {
      const row = ${hudRow(row.displayTitle)};
      return row?.querySelector('.title')?.textContent === ${JSON.stringify(metadata.conversationTitle)}
        && row.querySelector('.browser-source-label')?.textContent === ${JSON.stringify(row.label)}
        && row.querySelector('.browser-request-preview')?.textContent === ${JSON.stringify(`依頼：${metadata.requestPreview}`)};
    })()`));
  }
  assert.equal(hud.isVisible(), true);
  await clickHud(hud, second.displayTitle, true);
  await until("second session selected by its HUD details button", async () => {
    const value = await reopened.webContents.executeJavaScript("window.mori.status()");
    const selected = await reopened.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#sessions .session-selected');
      return card?.querySelector('.session-name')?.textContent === ${JSON.stringify(secondMetadata.conversationTitle)}
        && card.querySelector('.session-request-preview')?.textContent === ${JSON.stringify(`直近の依頼：${secondMetadata.requestPreview}`)};
    })()`);
    return value.selectedSessionId === second.id && selected;
  });

  const customLabel = "議事録テスト";
  const inputGeometry = await reopened.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.session-selected .session-label-input');
    const save = input?.form.querySelector('button[type="submit"]');
    if (!input || !save) return null;
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = element => { const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { input: rect(input), save: rect(save), viewport: { left: 0, top: 0,
      right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight } };
  })()`);
  assert.ok(inputGeometry && inside(inputGeometry.input, inputGeometry.viewport), "the selected session's real label input must be visible");
  assert.ok(inside(inputGeometry.save, inputGeometry.viewport), "the selected session's real Save button must be visible");
  await reopened.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.session-selected .session-label-input');
    input.value = ${JSON.stringify(customLabel)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
  })()`);
  await panelRow(reopened, second.sessionId, row => row.customLabel === customLabel && row.displayTitle === customLabel);
  await until("saved local name in the populated HUD", () => hud.webContents.executeJavaScript(
    `${hudRow(customLabel)}?.querySelector('.title')?.textContent === ${JSON.stringify(customLabel)}`));
  await assertDetailsGeometry(hud, customLabel);
  // A live observation must not wipe a draft or replace the focused input.
  await reopened.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.session-selected .session-label-input');
    input.focus(); input.value = '入力途中';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const heartbeat = fixtureEvent(2, 2);
  await deliverFixture(client, heartbeat);
  await panelRow(reopened, second.sessionId, row => row.lastObservationAt === heartbeat.observedAt);
  await until("the live refresh preserves the edited input", () => reopened.webContents.executeJavaScript(
    "document.querySelector('.session-selected .session-label-input')?.value === '入力途中' && document.activeElement === document.querySelector('.session-selected .session-label-input')"));
  await closePanel(reopened);
  await clickHud(hud, customLabel, true);
  reopened = await findWindow("mori-browser.html");
  await until("saved name and selected details survive reopening", () => reopened.webContents.executeJavaScript(
    `document.querySelector('.session-selected .session-label-input')?.value === ${JSON.stringify(customLabel)}`));
  console.log("PASS: two real HUD rows, selected-session details IPC, local name save, live draft preservation, and reopened details.");

  await deliverFixture(client, fixtureEvent(1, 2, { kind: "terminal", phase: "settled", outcome: "unverified" }));
  const unsupportedEvent = fixtureEvent(1, 3, { phase: "settled", outcome: "unverified", observation: "unsupported" });
  await deliverFixture(client, unsupportedEvent);
  const unsupported = await panelRow(reopened, first.sessionId, row => row.status === "unsupported" && row.requiresCompletionAck);
  assert.equal(unsupported.canFocus, true);
  await until("unsupported HUD row remains focusable", () => hud.webContents.executeJavaScript(
    `(() => { const row = ${hudRow(first.displayTitle)}; return !!row && !row.classList.contains('row-unfocusable') && row.querySelector('.state-chip')?.textContent === ${JSON.stringify(unsupported.statusLabel)}; })()`));
  await assertDetailsGeometry(hud, first.displayTitle);
  await clickHud(hud, first.displayTitle);
  const focus = await client.take("focus.request");
  for (const key of ["browserRunId", "sessionId", "tabId", "pageInstanceId", "routeRevision", "conversationRef"]) {
    assert.equal(focus[key], unsupportedEvent[key]);
  }
  assert.equal(focus.noticeSequence, unsupported.noticeSequence);
  // This response models an exact-document success. No real Chrome window is
  // focused in this fixture; the desktop's identity/receipt gates remain real.
  client.send({ type: "focus.result", requestId: focus.requestId, ok: true,
    browserRunId: focus.browserRunId, sessionId: focus.sessionId,
    pageInstanceId: focus.pageInstanceId, routeRevision: focus.routeRevision, conversationRef: focus.conversationRef });
  await panelRow(reopened, first.sessionId, row => row.requiresCompletionAck === false);
  assert.equal(JSON.stringify(client.frames).includes(customLabel), false, "the local display name must not be sent to the browser fixture");
  console.log("PASS: unsupported-state HUD click reaches the authenticated focus request and acknowledges its captured receipt after a matching fixture response.");

  // Leave one real receipt pending so the history link must preserve it and
  // open its custom-named record after the authenticated client disconnects.
  await deliverFixture(client, fixtureEvent(2, 3, { kind: "terminal", phase: "settled", outcome: "unverified" }));
  const retained = await panelRow(reopened, second.sessionId, row => row.requiresCompletionAck && row.unreadCount === 1);
  const focusRequestsBeforeDisconnect = client.frames.filter(frame => frame.type === "focus.request").length;
  const closed = bounded(new Promise(resolve => client.socket.once("close", resolve)), "close the synthetic browser");
  client.socket.close(1000, "native-smoke-disconnect");
  await closed;
  const disconnected = await panelRow(reopened, second.sessionId, row => row.statusReason === "disconnected");
  assert.equal(disconnected.status, "unknown");
  assert.equal(disconnected.canFocus, false);
  assert.equal(disconnected.isCurrent, false);
  assert.equal(disconnected.isHistory, true);
  assert.equal(disconnected.unreadCount, retained.unreadCount);
  assert.equal(disconnected.noticeSequence, retained.noticeSequence);
  assert.ok(disconnected.statusDetail.length > 0);
  assert.ok(disconnected.recoveryHint.length > 0);
  await until("disconnected sessions move out of current HUD rows into one history link", () => hud.webContents.executeJavaScript(
    "document.querySelectorAll('.row-browser').length === 0 && document.querySelectorAll('.row-browser-history').length === 1 && document.querySelector('.row-browser-history .title')?.textContent === '以前の記録 2 件 · 未確認 1 件'"));
  await closePanel(reopened);
  await hud.webContents.executeJavaScript("document.querySelector('.row-browser-history').click()");
  reopened = await findWindow("mori-browser.html");
  await until("history opens its unread custom-named record with diagnostic details", () => reopened.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('#history-sessions .session-selected');
    const focusButton = card && [...card.querySelectorAll('.session-actions button')].find(button => button.textContent === 'タブへ戻る');
    return document.getElementById('history').open && document.getElementById('count').textContent === '0 件'
      && document.getElementById('history-count').textContent === '2 件'
      && document.getElementById('history-unread').textContent === '未確認 1 件'
      && document.querySelectorAll('#sessions>.session').length === 0
      && document.querySelectorAll('#history-sessions>.session').length === 2
      && !!focusButton?.disabled && card.querySelector('.session-detail')?.textContent === ${JSON.stringify(disconnected.statusDetail)}
      && card.querySelector('.session-recovery')?.textContent === ${JSON.stringify(disconnected.recoveryHint)}
      && card.querySelector('.session-name')?.textContent === ${JSON.stringify(customLabel)}
      && card.querySelector('.session-request-preview')?.textContent === ${JSON.stringify(`直近の依頼：${secondMetadata.requestPreview}`)}
      && card.querySelector('.session-label-input')?.value === ${JSON.stringify(customLabel)};
  })()`));
  const historyStatus = await reopened.webContents.executeJavaScript("window.mori.status()");
  assert.equal(historyStatus.selectedSessionId, disconnected.id);
  const historyRow = historyStatus.sessions.find(row => row.id === disconnected.id);
  assert.equal(historyRow.customLabel, customLabel);
  assert.equal(historyRow.conversationTitle, secondMetadata.conversationTitle);
  assert.equal(historyRow.requestPreview, secondMetadata.requestPreview);
  assert.equal(historyRow.unreadCount, retained.unreadCount);
  assert.equal(historyRow.noticeSequence, retained.noticeSequence);
  assert.equal(historyRow.requiresCompletionAck, true, "Opening history does not acknowledge the pending receipt");
  assert.equal(client.frames.filter(frame => frame.type === "focus.request").length, focusRequestsBeforeDisconnect);
  assert.deepEqual(rendererErrors, []);
  console.log("PASS: disconnected sessions become history, with correct counts, disabled tab focus, preserved name/title/request, and an unchanged unread receipt after opening details.");
  console.log("This native Windows check uses a synthetic authenticated loopback protocol client. It does not validate an installed Chrome extension, real AI DOM, or real Chrome focus.");
  clearTimeout(timeout);
  app.quit();
}).catch(error => {
  clearTimeout(timeout);
  browserFixture?.socket.terminate();
  console.error(`Native UI smoke: ${error.stack || error.message}`);
  app.exit(1);
});
