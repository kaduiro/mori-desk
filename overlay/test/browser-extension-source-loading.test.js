"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const extensionRoot = path.join(__dirname, "../extensions/browser-bridge");
const extensionId = "obooegdoanifidoffaodpobadpeiilcl";
function event() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

// Load the actual extension files, including its real transport and startup
// imports. The source overlay has no generated build-info.js, while runtime
// tests may run beside one; remove that generated artifact from this copy.
function boot(t, { buildInfo, missingImport } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mori-source-extension-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(extensionRoot, root, { recursive: true,
    filter: file => file !== path.join(extensionRoot, "build-info.js") });
  if (buildInfo) fs.writeFileSync(path.join(root, "build-info.js"),
    `globalThis.MoriBrowserBuildInfo = Object.freeze(${JSON.stringify(buildInfo)});\n`);
  if (missingImport) fs.unlinkSync(path.join(root, missingImport));
  const access = [];
  function area(name) {
    const data = {};
    return {
      async setAccessLevel(value) { access.push({ name, ...value }); },
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
    };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const chrome = {
    runtime: { id: extensionId, onMessage: event(), onStartup: event(), onInstalled: event(),
      getManifest: () => manifest, getURL: file => `chrome-extension://${extensionId}/${file}`,
      async openOptionsPage() {} },
    storage: { local: area("local"), session: area("session") },
    tabs: { onUpdated: event(), onRemoved: event() },
    permissions: { onAdded: event(), onRemoved: event() },
    alarms: { onAlarm: event(), async create() {} },
    action: { onClicked: event() },
  };
  const imported = [];
  const context = vm.createContext({ chrome, crypto: crypto.webcrypto, URL, TextEncoder, TextDecoder,
    structuredClone, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval,
    importScripts(...files) {
      for (const file of files) {
        imported.push(file);
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
      }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "service-worker.js"), "utf8"), context,
    { filename: "service-worker.js" });
  async function status() {
    assert.equal(chrome.runtime.onMessage.listeners.length, 1);
    return new Promise(resolve => {
      const handled = chrome.runtime.onMessage.listeners[0]({ type: "mori.options.status" },
        { id: extensionId, url: chrome.runtime.getURL("options.html") }, resolve);
      assert.equal(handled, true);
    });
  }
  return { context, imported, access, status, manifest };
}

test("source overlay worker starts without generated build metadata and answers the real options request", async t => {
  const worker = boot(t);
  const status = await worker.status();
  assert.equal(status.ok, true);
  assert.equal(status.version, worker.manifest.version);
  assert.equal(status.connection.state, "unpaired");
  assert.equal(status.paired, false);
  assert.equal(status.peer, null);
  assert.equal(worker.context.MoriBrowserBuildInfo, null, "missing build identity must stay unknown");
  assert.ok(worker.imported.includes("transport.js"), "load actual mandatory product modules");
  assert.deepEqual(worker.access, [
    { name: "local", accessLevel: "TRUSTED_CONTEXTS" },
    { name: "session", accessLevel: "TRUSTED_CONTEXTS" },
  ]);
});

test("a constructed extension retains its supplied build identity through worker startup", async t => {
  const buildInfo = { extensionVersion: "0.1.8", buildId: "a".repeat(64), observerContract: 1 };
  const worker = boot(t, { buildInfo });
  assert.equal((await worker.status()).ok, true);
  assert.deepEqual(structuredClone(worker.context.MoriBrowserBuildInfo), buildInfo);
});

test("a missing mandatory worker import still stops startup", t => {
  assert.throws(() => boot(t, { missingImport: "provider-utils.js" }), error =>
    error.code === "ENOENT" && error.path.endsWith(`${path.sep}provider-utils.js`));
});
