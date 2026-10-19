"use strict";

const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const rendererErrors = [];
if (process.platform !== "win32" || !process.env.MORI_DESK_TEST_DATA_DIR) {
  throw new Error("Run through scripts/smoke-windows-ui.js with an owned Windows profile.");
}
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => rendererErrors.push(`preload: ${error.message}`));
  contents.on("render-process-gone", (_event, details) => rendererErrors.push(`renderer: ${details.reason}`));
});

// Load the real composition root, including safeStorage, the HUD owner, the
// browser panel and their sandboxed preloads. Browser sessions remain empty.
require("../src/main");

const timeout = setTimeout(() => {
  console.error("Native UI smoke timed out while waiting for Mori windows.");
  app.exit(1);
}, 45000);
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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

  panel.close();
  await delay(100);
  await hud.webContents.executeJavaScript("document.querySelector('.row-browser-status').click()");
  const reopened = await findWindow("mori-browser.html");
  assert.equal(reopened.isVisible(), true);
  assert.deepEqual(rendererErrors, []);
  console.log("PASS: native Windows Electron main, secure-storage readiness, visible empty HUD, and HUD-to-browser-panel IPC.");
  console.log("This check does not connect an installed Chrome extension or a real AI conversation.");
  clearTimeout(timeout);
  app.quit();
}).catch(error => {
  clearTimeout(timeout);
  console.error(`Native UI smoke: ${error.stack || error.message}`);
  app.exit(1);
});
