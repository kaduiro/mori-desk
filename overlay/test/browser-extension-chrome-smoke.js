/* SPDX-License-Identifier: AGPL-3.0-only */
"use strict";

// Optional real-Chrome extension lifecycle smoke. Run the reconstructed file
// after `npm run setup`; this is deliberately not a *.test.js regression test.
// Only a new temporary Chrome profile and a fixed synthetic ChatGPT page are
// used. No live provider page/account, native window focus, or OS encryption is
// validated. The bridge uses an explicitly synthetic safeStorage test double.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const BASELINE_VERSION = "0.1.5";
const CURRENT_VERSION = "0.1.6";
const FIXTURE_URL = "https://chatgpt.com/c/fixture-recovery";
const PORTS = [23333, 23334, 23335, 23336, 23337];
const ARGUMENTS = {
  "--chrome": ["chrome", "MORI_CHROME_EXECUTABLE"],
  "--playwright": ["playwright", "MORI_PLAYWRIGHT_MODULE"],
  "--baseline-extension": ["baselineExtension", "MORI_BASELINE_EXTENSION"],
  "--output-dir": ["outputDirectory", "MORI_CHROME_SMOKE_OUTPUT_DIR"],
};
const HELP = `Usage (after npm run setup):
  node .runtime/test/browser-extension-chrome-smoke.js \\
    --chrome /path/to/chrome \\
    --playwright /path/to/node_modules/playwright \\
    --baseline-extension /path/to/0.1.5/browser-bridge \\
    --output-dir /path/to/smoke-results

Each option can instead be supplied through its environment variable:
  --chrome              MORI_CHROME_EXECUTABLE
  --playwright          MORI_PLAYWRIGHT_MODULE
  --baseline-extension  MORI_BASELINE_EXTENSION
  --output-dir          MORI_CHROME_SMOKE_OUTPUT_DIR

All four paths are required. CLI options override environment variables.
Playwright may be a package directory or its module entry file. The current
extension and bridge are resolved relative to this reconstructed test file.
The baseline must be an unmodified 0.1.5 extension directory; it is copied,
never changed. Chrome runs headless with an isolated temporary profile.
Developer mode is enabled through chrome://extensions in that new profile;
managed browser restrictions are not bypassed. Chrome inherits the environment
(including optional font configuration). No packages or browsers are downloaded.

Outputs: chrome-recovery-results.json and chrome-recovery-options.png.
Only this run's mkdtemp directory is removed; the requested output is retained.
This checks synthetic DOM and a safeStorage test double, not live provider DOM
or the operating system's credential encryption.
`;

class SmokeError extends Error {}

function configuration() {
  if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) {
    process.stdout.write(HELP);
    return null;
  }
  const values = {};
  for (const [key, variable] of Object.values(ARGUMENTS)) values[key] = process.env[variable];
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const equal = args[index].indexOf("=");
    const flag = equal < 0 ? args[index] : args[index].slice(0, equal);
    if (!Object.hasOwn(ARGUMENTS, flag)) throw new SmokeError("Unknown option; use --help.");
    const value = equal < 0 ? args[++index] : args[index].slice(equal + 1);
    if (!value || value.startsWith("--")) throw new SmokeError(`Missing path for ${flag}.`);
    values[ARGUMENTS[flag][0]] = value;
  }
  for (const [flag, [key]] of Object.entries(ARGUMENTS)) {
    if (!values[key]) throw new SmokeError(`Supply ${flag} or its environment variable; use --help.`);
    values[key] = path.resolve(values[key]);
  }
  for (const [key, directory] of [["chrome", false], ["baselineExtension", true]]) {
    let stat;
    try { stat = fs.statSync(values[key]); } catch { /* Report the argument, not an arbitrary path. */ }
    if (!stat || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new SmokeError(key === "chrome" ? "--chrome must name an existing executable file."
        : "--baseline-extension must name an existing extension directory.");
    }
  }
  return values;
}

function readManifest(directory, version, description) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8")); }
  catch { throw new SmokeError(`Cannot read the ${description} extension manifest.`); }
  if (manifest.version !== version) throw new SmokeError(`The ${description} extension must be version ${version}.`);
  return manifest;
}

// Avoid raw Playwright call logs, page text, pairing codes, keys, or storage
// dumps on failure. A fixed stage plus a small error category is sufficient.
function failureDescription(error) {
  if (error instanceof SmokeError) return error.message;
  if (error?.name === "AssertionError") return "An expected count or preservation check failed.";
  if (error?.name === "TimeoutError") return "Chrome did not complete the operation within its timeout.";
  const codes = new Set(["EACCES", "EPERM", "ENOENT", "EADDRINUSE", "ENOSPC", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
  return codes.has(error?.code) ? `Operation failed (${error.code}).` : "The operation failed; inspect the named stage.";
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new SmokeError(`Timed out: ${label}.`);
}

async function listen(server) {
  for (const port of PORTS) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      return port;
    } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  }
  throw new SmokeError("None of the bridge's permitted loopback ports is available.");
}

const HTML = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>Recovery fixture</title><body>
<nav><a href="/c/fixture-recovery">監視の復旧テスト</a></nav>
<main><div data-message-author-role="user">送信済みのテスト依頼</div><div data-message-author-role="assistant">合成回答</div></main>
<form><textarea id="prompt-textarea" style="width:300px;height:80px"></textarea></form>
<script>window.fixtureDocumentToken=crypto.randomUUID();</script></body></html>`;

async function run(config) {
  let chromium;
  try { ({ chromium } = require(config.playwright)); }
  catch { throw new SmokeError("Cannot load Playwright from --playwright; supply its package directory or module entry file."); }
  if (typeof chromium?.launchPersistentContext !== "function") throw new SmokeError("The supplied Playwright module has no Chromium launcher.");
  const { createBrowserBridge } = require("../src/browser-bridge-server");
  const { EXTENSION_ID } = require("../src/browser-bridge-protocol");
  const currentExtension = path.resolve(__dirname, "../extensions/browser-bridge");
  const baselineManifest = readManifest(config.baselineExtension, BASELINE_VERSION, "baseline");
  const currentManifest = readManifest(currentExtension, CURRENT_VERSION, "current");
  if (!baselineManifest.key || baselineManifest.key !== currentManifest.key) {
    throw new SmokeError("Baseline and current extensions must have the same fixed extension identity.");
  }
  fs.mkdirSync(config.outputDirectory, { recursive: true });
  const ownedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-chrome-recovery-"));
  const extensionPath = path.join(ownedDirectory, "extension");
  const optionsUrl = `chrome-extension://${EXTENSION_ID}/options.html`;
  const workerUrl = `chrome-extension://${EXTENSION_ID}/service-worker.js`;
  const result = {
    browser: null, platform: process.platform, headless: true,
    providerPage: "fixed synthetic ChatGPT HTML; provider requests intercepted; no live service/account",
    desktopStorage: "isolated synthetic safeStorage test double; no OS encryption validation",
    baselineExtension: BASELINE_VERSION, currentExtension: CURRENT_VERSION,
    phases: [], success: false,
  };
  let stage = "prepare-isolated-fixture";
  let bridge;
  let server;
  let context;
  let options;
  let worker;
  let page;
  let pageLoads = 0;
  const option = message => options.evaluate(value => chrome.runtime.sendMessage(value), message);
  const documentState = () => page.evaluate(() => ({
    token: window.fixtureDocumentToken, draft: document.querySelector("#prompt-textarea").value,
    stop: !!document.querySelector('[data-testid="stop-button"]'),
    navigations: performance.getEntriesByType("navigation").length,
  }));
  const unreadCount = () => bridge.getSnapshot().reduce((sum, row) => sum
    + (row.unreadCount || row.pendingCompletionCount || (row.requiresCompletionAck ? 1 : 0)), 0);
  async function refreshWorker(expectedVersion) {
    const previousWorker = worker;
    // runtime.reload can destroy its own execution context before returning.
    // Confirm a new worker below; do not treat a swallowed error as a reload.
    await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await sleep(500);
    // Extension reload closes options pages. Always create a fresh one instead
    // of sending messages through an invalidated extension document.
    if (options && !options.isClosed()) await options.close();
    options = await context.newPage();
    await until(async () => {
      try { await options.goto(optionsUrl, { waitUntil: "domcontentloaded", timeout: 2000 }); return true; }
      catch { return false; }
    }, "options page after extension reload");
    await until(async () => {
      try { return (await option({ type: "mori.options.status" }))?.connection?.state === "connected"; }
      catch { return false; }
    }, "authenticated reconnection");
    worker = await until(() => context.serviceWorkers().find(candidate => candidate !== previousWorker
      && candidate.url() === workerUrl), "replacement extension worker");
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), expectedVersion);
  }

  try {
    fs.cpSync(config.baselineExtension, extensionPath, { recursive: true, dereference: true });
    const prefix = "synthetic-vault:";
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(prefix + value),
      decryptString: value => value.toString().slice(prefix.length),
    };
    bridge = createBrowserBridge({ dataDir: path.join(ownedDirectory, "desktop-fixture"), safeStorage });
    server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    bridge.attach(server);
    stage = "listen-on-permitted-loopback-port";
    const port = await listen(server);
    stage = "launch-new-chrome-profile";
    context = await chromium.launchPersistentContext(path.join(ownedDirectory, "profile"), {
      executablePath: config.chrome, headless: true, ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    context.setDefaultTimeout(5000);
    result.browser = await context.browser().version();
    // Fulfill the single known document locally and abort all other page
    // HTTP(S) requests, including requests to either provider. Extension assets
    // and the authenticated loopback WebSocket are unaffected by this route.
    await context.route(/^https?:\/\//, route => {
      if (route.request().url() === FIXTURE_URL && route.request().resourceType() === "document") {
        pageLoads++;
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HTML });
      }
      return route.abort();
    });
    stage = "enable-developer-mode-in-test-profile";
    const extensionManager = await context.newPage();
    await extensionManager.goto("chrome://extensions");
    const devMode = extensionManager.locator("extensions-toolbar #devMode");
    if (!(await devMode.isEnabled())) throw new SmokeError("Chrome does not allow developer mode; browser policy is not changed by this test.");
    if (!(await devMode.evaluate(element => element.checked))) await devMode.click();
    assert.equal(await devMode.evaluate(element => element.checked), true);
    await extensionManager.close();
    worker = await until(() => context.serviceWorkers().find(candidate => candidate.url() === workerUrl), "baseline extension worker");
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), BASELINE_VERSION);

    stage = "pair-and-observe-synthetic-page";
    page = await context.newPage();
    await page.goto(FIXTURE_URL);
    options = await context.newPage();
    await options.goto(optionsUrl);
    const pairing = await option({ type: "mori.options.pair", code: bridge.beginPairing(port).code });
    assert.equal(pairing.ok, true);
    await until(() => bridge.getSnapshot().some(row => row.isCurrent), "initial current session");
    await page.locator("#prompt-textarea").fill("未送信の文章を保持するテスト");
    const start = () => page.evaluate(() => {
      const button = document.createElement("button");
      button.dataset.testid = "stop-button";
      button.textContent = "Stop";
      document.body.append(button);
    });
    stage = "create-unread-receipt-and-active-generation";
    await start();
    await until(() => bridge.getSnapshot().some(row => row.isCurrent && row.phase === "running"), "initial generation");
    await page.locator('[data-testid="stop-button"]').evaluate(element => element.remove());
    await until(() => bridge.getSnapshot().some(row => row.requiresCompletionAck), "durable unread completion");
    assert.equal(unreadCount(), 1);
    await start();
    await until(() => bridge.getSnapshot().some(row => row.isCurrent && row.phase === "running"), "second generation");
    const before = await documentState();
    const baselineLoads = pageLoads;

    stage = "reproduce-0.1.5-reload-failure";
    await refreshWorker(BASELINE_VERSION);
    const broken = await option({ type: "mori.options.health" });
    assert.equal(broken.counts.needsReload, 1);
    assert.deepEqual(broken.observationDelivery, { accepted: 0, rejected: 0, unconfirmed: 0, runningAccepted: 0, reasons: {} });
    assert.equal(pageLoads, baselineLoads);
    assert.deepEqual(await documentState(), before);
    assert.equal(unreadCount(), 1);
    result.phases.push({ phase: "0.1.5 extension reload reproduces reported failure", counts: broken.counts,
      observationDelivery: broken.observationDelivery, pageReloaded: false, draftPreserved: true, unreadPreserved: true });

    stage = "update-to-0.1.6-without-page-reload";
    // Both copies are under this run's mkdtemp root. The supplied baseline and
    // current source directories are read-only inputs throughout the smoke.
    fs.rmSync(extensionPath, { recursive: true, force: true });
    fs.cpSync(currentExtension, extensionPath, { recursive: true, dereference: true });
    await refreshWorker(CURRENT_VERSION);
    const recovered = await until(async () => {
      const health = await option({ type: "mori.options.health" });
      return health.counts.running === 1 && health.observationDelivery.accepted === 1 ? health : null;
    }, "0.1.6 current observer recovery");
    assert.equal(recovered.counts.needsReload, 0);
    assert.equal(pageLoads, baselineLoads);
    assert.deepEqual(await documentState(), before);
    assert.equal(unreadCount(), 1);
    await until(() => bridge.getSnapshot().some(row => row.isCurrent && row.phase === "running"), "recovered state reaches bridge");
    result.phases.push({ phase: "0.1.5 -> 0.1.6 update automatically recovers existing document", counts: recovered.counts,
      recovery: recovered.observerRecovery, observationDelivery: recovered.observationDelivery, siteAccess: recovered.siteAccess,
      pageReloaded: false, draftPreserved: true, unreadPreserved: true });

    stage = "avoid-duplicate-recovery-for-healthy-observer";
    const repeat = await option({ type: "mori.options.health" });
    assert.equal(repeat.counts.running, 1);
    assert.equal(repeat.observerRecovery.attempted, 0);
    stage = "recover-after-second-0.1.6-extension-reload";
    await refreshWorker(CURRENT_VERSION);
    const again = await until(async () => {
      const health = await option({ type: "mori.options.health" });
      return health.counts.running === 1 && health.observationDelivery.accepted === 1 ? health : null;
    }, "0.1.6 extension reload recovery");
    assert.equal(again.counts.needsReload, 0);
    assert.equal(pageLoads, baselineLoads);
    assert.deepEqual(await documentState(), before);
    assert.equal(unreadCount(), 1);
    result.phases.push({ phase: "0.1.6 extension reload automatically recovers again", counts: again.counts,
      observationDelivery: again.observationDelivery, pageReloaded: false, draftPreserved: true, unreadPreserved: true });

    stage = "capture-options-diagnostic";
    await options.locator("#check-tabs").click();
    await until(() => options.locator("#tab-health").textContent().then(text => text.includes("生成中 1 件")), "options diagnostic render");
    await options.screenshot({ path: path.join(config.outputDirectory, "chrome-recovery-options.png"), fullPage: true });
    result.success = true;
  } catch (error) {
    result.failure = { stage, error: failureDescription(error) };
  } finally {
    // Run every cleanup even if one fails. Never remove the caller's output,
    // Chrome executable, extension inputs, or any pre-existing profile.
    const cleanup = async (label, operation) => {
      try { await operation(); }
      catch (error) {
        result.success = false;
        result.failure ||= { stage: label, error: failureDescription(error) };
      }
    };
    await cleanup("close-test-browser", () => context?.close());
    await cleanup("dispose-test-bridge", () => bridge?.dispose());
    await cleanup("close-test-server", async () => {
      if (!server?.listening) return;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });
    await cleanup("remove-owned-temporary-data", () => fs.rmSync(ownedDirectory,
      { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    result.temporaryDataRemoved = !fs.existsSync(ownedDirectory);
  }
  fs.writeFileSync(path.join(config.outputDirectory, "chrome-recovery-results.json"), JSON.stringify(result, null, 2) + "\n");
  if (result.success) {
    console.log(`PASS: Chrome ${result.browser}; 0.1.5 failure reproduced, 0.1.6 update/reload recovered without F5.`);
    console.log("PASS: the same document, draft and unread receipt survived; healthy observers were not reinjected.");
    console.log(`Results: ${path.join(config.outputDirectory, "chrome-recovery-results.json")}`);
  } else {
    process.exitCode = 1;
    console.error(JSON.stringify({ success: false, ...result.failure }));
  }
}

(async () => {
  const config = configuration();
  if (config) await run(config);
})().catch(error => {
  process.exitCode = 1;
  console.error(JSON.stringify({ success: false, stage: "configuration-or-results", error: failureDescription(error) }));
});
