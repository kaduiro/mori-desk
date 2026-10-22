/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';

// New acceptance boundary substitutes. This file intentionally imports no test
// helper, selector table, reducer or expected-value generator from the product.
// Product files are loaded only as the system under test. It is NOT Chrome,
// provider DOM evidence, a natural worker-lifetime test, or OS safeStorage.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const clone = value => value === undefined ? undefined : structuredClone(value);
const extensionId = 'obooegdoanifidoffaodpobadpeiilcl';
const sourceRoot = process.env.MORI_INDEPENDENT_ROOT || path.resolve(__dirname, '../..');
const productRoot = fs.existsSync(path.join(sourceRoot, 'extensions')) ? sourceRoot : path.join(sourceRoot, 'overlay');
const extensionRoot = path.join(productRoot, 'extensions/browser-bridge');
const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, 'recovery-independent-ledger-v1.json'), 'utf8'));

class IndependentClock {
  constructor() { this.now = 1800000000000; this.serial = 0; this.tasks = new Map(); }
  schedule(fn, delay, interval = 0) {
    const id = ++this.serial;
    this.tasks.set(id, { id, fn, at: this.now + Math.max(0, Number(delay) || 0), interval });
    return id;
  }
  clear(id) { this.tasks.delete(id); }
  async drain() {
    // Yield to the host once, rather than guessing how many product Promise
    // continuations are needed for an API boundary to settle.
    await new Promise(resolve => setImmediate(resolve));
  }
  async advance(milliseconds) {
    await this.drain();
    const end = this.now + milliseconds;
    for (let count = 0; count < 20000; count++) {
      const next = [...this.tasks.values()].filter(task => task.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) { this.now = end; await this.drain(); return; }
      this.now = next.at;
      if (next.interval) next.at += next.interval;
      else this.tasks.delete(next.id);
      next.fn();
      await this.drain();
    }
    throw new Error('Independent clock detected an unbounded product timer loop');
  }
  globals() {
    const clock = this;
    return {
      Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
      setTimeout: (fn, delay) => clock.schedule(fn, delay), clearTimeout: id => clock.clear(id),
      setInterval: (fn, delay) => clock.schedule(fn, delay, Math.max(1, delay)), clearInterval: id => clock.clear(id),
    };
  }
}

class IndependentEvent {
  constructor() { this.listeners = new Set(); }
  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }
  fire(...args) { for (const fn of [...this.listeners]) fn(...args); }
  request(message, sender) {
    return new Promise((resolve, reject) => {
      let claimed = false;
      let answered = false;
      const reply = value => { answered = true; resolve(clone(value)); };
      for (const listener of [...this.listeners]) {
        if (listener(clone(message), clone(sender), reply) === true) claimed = true;
      }
      if (!claimed && !answered) reject(new Error('Independent boundary: no receiving listener'));
    });
  }
}

// A deliberately small generic node tree supports the public, synthetic
// conventional controls below. It does not add a made-up conversation binding.
class IndependentElement {
  constructor(tag, attributes = {}, text = '') {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attributes = { ...attributes };
    this.childNodes = text ? [{ nodeType: 3, nodeValue: text }] : [];
    this.parentElement = null; this.hidden = false; this.readOnly = false;
  }
  getAttribute(key) { return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getClientRects() { return this.hidden ? [] : [{ width: 100, height: 20 }]; }
  get isConnected() { return !!this.parentElement || this.tagName === 'BODY'; }
  append(...children) { for (const child of children) { child.parentElement = this; this.childNodes.push(child); } }
  matches(selector) {
    return selector.split(',').some(part => {
      let expression = part.trim();
      const excluded = [...expression.matchAll(/:not\(([^)]+)\)/g)].map(match => match[1]);
      expression = expression.replace(/:not\([^)]+\)/g, '');
      if (excluded.some(value => this.matches(value))) return false;
      const tag = expression.match(/^[a-z][a-z0-9-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = expression.match(/#([a-z0-9_-]+)/i)?.[1];
      if (id && this.getAttribute('id') !== id) return false;
      for (const match of expression.matchAll(/\[([^\]=\s]+)(?:\s*=\s*["']?([^\]"']+)["']?)?\]/g)) {
        const actual = this.getAttribute(match[1]);
        if (actual === null || (match[2] !== undefined && actual !== match[2])) return false;
      }
      return !!expression && !/[ >+~]/.test(expression.replace(/\[[^\]]*\]/g, ''));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const matches = [];
    const visit = node => { for (const child of node.childNodes || []) if (child.nodeType === 1) { if (child.matches(selector)) matches.push(child); visit(child); } };
    visit(this); return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function independentDocument(conversation = ledger.conversations.A, { generating = false } = {}) {
  const events = new Map();
  const body = new IndependentElement('body');
  const navigation = new IndependentElement('nav');
  navigation.append(new IndependentElement('a', { href: conversation.route }, conversation.title));
  const main = new IndependentElement('main');
  const composer = new IndependentElement('textarea', { id: 'prompt-textarea' });
  composer.value = conversation.draftText;
  const doc = {
    body, readyState: 'complete', visibilityState: 'visible', prerendering: false,
    querySelectorAll: selector => body.querySelectorAll(selector), querySelector: selector => body.querySelector(selector),
    addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener: (name, fn) => events.get(name)?.delete(fn),
    dispatch: name => { for (const fn of events.get(name) || []) fn({ type: name }); },
  };
  body.append(navigation, main, composer);
  const replaceCentral = (owner, running) => {
    for (const node of main.childNodes) node.parentElement = null;
    main.childNodes = [];
    main.append(new IndependentElement('section', { 'data-message-author-role': 'user' }, owner.submittedText));
    // Answers exist only as structural control nodes; their text is a trap.
    main.append(new IndependentElement('section', { 'data-message-author-role': 'assistant' }, 'ASSISTANT_NOT_ALLOWED'));
    if (running) main.append(new IndependentElement('button', { 'data-testid': 'stop-button' }, 'Stop'));
  };
  const replaceNavigation = owner => {
    navigation.childNodes = [];
    navigation.append(new IndependentElement('a', { href: owner.route }, owner.title));
  };
  replaceCentral(conversation, generating);
  return { doc, composer, main, navigation, replaceCentral, replaceNavigation };
}

function createWorkerBoundary({ queryFault = null, storageFault = null, autoReady = true, seedLocal = {}, seedSession = {} } = {}) {
  const clock = new IndependentClock();
  const log = { queries: [], writes: [], deliveries: [], outbound: [], inbound: [], injections: [], transport: [], errors: [], driverActions: [] };
  const local = { moriClientId: 'independent-client', moriCredential: {
    clientId: 'independent-client', instanceId: 'independent-desktop', port: 23333, key: Buffer.alloc(32, 7).toString('base64url'),
  }, moriSettings: { enabled: true }, ...clone(seedLocal) };
  const session = clone(seedSession);
  const pages = new Map();
  const runtimeMessages = new IndependentEvent();
  const alarms = new IndependentEvent();
  const alarmTimers = new Map();
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  let fault = queryFault;
  let storageFailure = storageFault;
  let transportInstance;
  let worker;
  const area = (name, state) => ({
    async setAccessLevel() { if (storageFailure === `${name}.access`) throw new Error('independent storage failure'); },
    async get(keys) {
      if (storageFailure === `${name}.get`) throw new Error('independent storage failure');
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(state);
      return clone(Object.fromEntries(list.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])));
    },
    async set(value) {
      if (storageFailure === `${name}.set`) throw new Error('independent storage failure');
      Object.assign(state, clone(value)); log.writes.push({ at: clock.now, area: name, value: clone(value) });
    },
  });
  const chrome = {
    storage: { local: area('local', local), session: area('session', session) },
    runtime: { id: extensionId, getManifest: () => clone(manifest), getURL: value => `chrome-extension://${extensionId}/${value}`,
      onMessage: runtimeMessages, onStartup: new IndependentEvent(), onInstalled: new IndependentEvent(), openOptionsPage() {} },
    action: { onClicked: new IndependentEvent() },
    permissions: { async contains() { return true; } },
    alarms: { onAlarm: alarms, async create(name, options) {
      if (alarmTimers.has(name)) clock.clear(alarmTimers.get(name));
      alarmTimers.set(name, clock.schedule(() => alarms.fire({ name }), options.periodInMinutes * 60000, options.periodInMinutes * 60000));
    } },
    windows: { async update(id) { log.driverActions.push({ type: 'product-window-focus', id }); return { id }; } },
    tabs: {
      onUpdated: new IndependentEvent(), onRemoved: new IndependentEvent(),
      query(options) {
        log.queries.push({ at: clock.now, options: clone(options), fault: typeof fault === 'string' ? fault : null });
        if (typeof fault === 'function') return fault({ clock, pages, options });
        if (fault === 'throw') throw new Error('Independent enumeration unavailable');
        if (fault === 'reject') return Promise.reject(new Error('Independent enumeration unavailable'));
        if (fault === 'pending') return new Promise(() => {});
        return Promise.resolve([...pages.values()].map(page => clone(page.tab)));
      },
      async get(id) { const page = pages.get(id); if (!page) throw new Error('Independent tab missing'); return clone(page.tab); },
      async update(id) { log.driverActions.push({ type: 'product-tab-focus', id }); return clone(pages.get(id)?.tab); },
      sendMessage(id, message, target = {}) {
        const page = pages.get(id);
        log.outbound.push({ at: clock.now, tabId: id, message: clone(message), target: clone(target) });
        if (!page || (target.documentId && target.documentId !== page.documentId)) return Promise.reject(new Error('Independent document missing'));
        return page.messages.request(message, { id: extensionId });
      },
    },
    scripting: {
      async executeScript(request) {
        const page = pages.get(request.target.tabId);
        if (!page || (request.target.documentIds && !request.target.documentIds.includes(page.documentId))) throw new Error('Independent document missing');
        if (request.files) {
          log.injections.push({ at: clock.now, tabId: page.tab.id, files: [...request.files] });
          for (const filename of request.files) runPageFile(page, filename);
          return [{ frameId: 0, documentId: page.documentId }];
        }
        page.context.__independentInvocationArgs = clone(request.args || []);
        const result = await vm.runInContext(`(${request.func.toString()})(...__independentInvocationArgs)`, page.context);
        return [{ frameId: 0, documentId: page.documentId, result: clone(result) }];
      },
    },
  };
  class IndependentTransportBoundary {
    constructor(options) { this.options = options; this.enabled = false; this.ready = false; transportInstance = this; log.transport.push({ at: clock.now, action: 'construct' }); }
    setEnabled(enabled) {
      this.enabled = enabled; this.ready = !!enabled;
      log.transport.push({ at: clock.now, action: enabled ? 'enable' : 'disable' });
      if (enabled) {
        this.options.onStatus({ state: 'connected', code: null });
        if (autoReady) Promise.resolve().then(() => this.options.onReady()).catch(error => log.errors.push(error.message));
      }
    }
    isReady() { return this.ready; }
    async ensureConnected() { return this.enabled; }
    disconnect() { this.ready = false; }
    async sendEvent(event) {
      log.deliveries.push({ at: clock.now, event: clone(event) });
      return { type: 'event.ack', browserRunId: event.browserRunId, sessionId: event.sessionId, eventId: event.eventId, sequence: event.sequence };
    }
  }
  const sharedGlobals = () => ({ console, URL, TextEncoder, TextDecoder, crypto: crypto.webcrypto, structuredClone, atob, btoa, ...clock.globals() });
  function runPageFile(page, filename) { vm.runInContext(fs.readFileSync(path.join(extensionRoot, filename), 'utf8'), page.context, { filename }); }
  function addPage(id, conversation = ledger.conversations.A, options = {}) {
    const shape = independentDocument(conversation, options);
    const events = new Map();
    const messages = new IndependentEvent();
    const url = `${conversation.provider === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com'}${conversation.route}`;
    const page = { ...shape, documentId: `independent-document-${id}`, messages,
      tab: { id, url, windowId: id + 100, status: 'complete', discarded: false }, mutations: [] };
    const pageChrome = { runtime: { id: extensionId, onMessage: messages, getManifest: () => clone(manifest), sendMessage(message) {
      log.inbound.push({ at: clock.now, tabId: id, message: clone(message) });
      return runtimeMessages.request(message, { id: extensionId, tab: clone(page.tab), url: page.tab.url,
        frameId: 0, documentId: page.documentId, documentLifecycle: 'active' });
    } } };
    page.context = vm.createContext({ ...sharedGlobals(), document: shape.doc, location: new URL(url), chrome: pageChrome,
      MutationObserver: class { constructor(fn) { this.fn = fn; page.mutations.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } },
      addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
      removeEventListener: (name, fn) => events.get(name)?.delete(fn),
    });
    page.fire = name => { for (const fn of events.get(name) || []) fn({ type: name }); };
    page.mutate = () => { for (const observer of page.mutations) if (observer.active) observer.fn([]); };
    page.setRoute = owner => { page.tab.url = `${owner.provider === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com'}${owner.route}`; page.context.location = new URL(page.tab.url); };
    page.install = () => { for (const filename of manifest.content_scripts[0].js) runPageFile(page, filename); };
    pages.set(id, page); return page;
  }
  function addProtocolPage(id, conversation = ledger.conversations.A) {
    // Explicit positive control at the observer/worker protocol boundary.
    // This stand-in attests an externally fixed conversation; it makes no claim
    // that ChatGPT/Claude exposes structural evidence for such an attestation.
    // The real content script is exercised separately against unbound DOM.
    const page = addPage(id, conversation);
    const pageInstanceId = `independent-attested-page-${id}`;
    const bindingEpoch = `independent-attested-binding-${id}`;
    let lease = null;
    let sequence = 0;
    const modern = manifest.version !== '0.1.6';
    const identity = () => ({ ok: true, v: 1, observerVersion: manifest.version, pageInstanceId,
      route: { provider: conversation.provider, path: conversation.route, conversationRef: conversation.route },
      binding: { state: page.bindingState || 'confirmed', epoch: bindingEpoch },
      lease: page.bindingState === 'unconfirmed' ? null : clone(lease) });
    page.protocol = { status: 'idle', generationToken: null, outcome: null };
    async function register(attemptId) {
      const grant = await page.context.chrome.runtime.sendMessage({ type: 'mori.observer.register', v: 1,
        pageInstanceId, observerVersion: manifest.version, attemptId });
      if (grant?.ok) {
        lease = { workerEpoch: grant.workerEpoch, leaseId: grant.leaseId, bindingEpoch: grant.bindingEpoch };
      }
      return grant;
    }
    page.context.MoriBrowserObserver = { start: ({ attemptId }) => register(attemptId) };
    async function publish() {
      if (modern && !lease) { const grant = await register(null); if (!grant?.ok) return grant; }
      return page.context.chrome.runtime.sendMessage({ type: 'mori.observation', v: 1, pageInstanceId,
        contentSequence: ++sequence, observedAt: clock.now, ...clone(page.protocol),
        conversationTitle: conversation.title, requestPreview: conversation.submittedText,
        ...(modern ? lease : {}) });
    }
    page.publish = () => { log.driverActions.push({ at: clock.now, type: 'independent-protocol-input', tabId: id }); return publish(); };
    page.identity = identity;
    page.messages.addListener((message, _sender, respond) => {
      if (message.type === 'mori.observer.identity') { respond(identity()); return; }
      if (message.type === 'mori.focus.check') {
        respond({ ok: message.pageInstanceId === pageInstanceId && message.conversationRef === conversation.route,
          pageInstanceId, conversationRef: conversation.route }); return;
      }
      if (message.type === 'mori.observe.now') {
        void publish().catch(error => log.errors.push(error.message));
        respond(identity()); return;
      }
      if (message.type === 'mori.health.check') {
        publish().then(acknowledgement => respond({ ...identity(), status: page.protocol.status, observationAck: acknowledgement }));
        return true;
      }
    });
    return page;
  }
  function start() {
    worker = vm.createContext({ ...sharedGlobals(), chrome });
    worker.importScripts = (...filenames) => {
      for (const filename of filenames) {
        vm.runInContext(fs.readFileSync(path.join(extensionRoot, filename), 'utf8'), worker, { filename });
        if (filename === 'transport.js') worker.MoriTransport.Transport = IndependentTransportBoundary;
      }
    };
    vm.runInContext(fs.readFileSync(path.join(extensionRoot, 'service-worker.js'), 'utf8'), worker, { filename: 'service-worker.js' });
  }
  return { clock, log, local, session, chrome, pages, addPage, addProtocolPage, start,
    releaseQuery: () => { fault = null; }, setQueryFault: value => { fault = value; }, setStorageFault: value => { storageFailure = value; },
    transport: () => transportInstance,
    options(type, extra = {}) { log.driverActions.push({ at: clock.now, type }); return runtimeMessages.request({ type, ...extra }, { id: extensionId, url: chrome.runtime.getURL('options.html') }); },
  };
}

// Exercise the actual server focus owner, auth, store and atomic persistence.
// The in-memory websocket substitutes only I/O, and the reversible key codec
// explicitly does not represent OS-protected safeStorage.
function createDesktopBoundary() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mori-independent-desktop-'));
  const received = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; }
    send(text, done) { received.push(JSON.parse(text)); done?.(); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
    end(text) { throw new Error(`Independent rejected upgrade: ${text}`); }
    input(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  }
  const ws = { WebSocket: { OPEN: 1 }, WebSocketServer: class { handleUpgrade(_request, socket, _head, callback) { callback(socket); } close() {} } };
  const filename = path.join(productRoot, 'src/browser-bridge-server.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const loaded = vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  loaded(name => name === 'ws' ? ws : localRequire(name), module, module.exports, path.dirname(filename), filename);
  let now = 1800000000000;
  const bridge = module.exports.createBrowserBridge({ dataDir, now: () => now, safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'independent-test-double',
    encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString(),
  } });
  const http = new EventEmitter(); http.address = () => ({ address: '127.0.0.1', port: 23333 });
  bridge.attach(http);
  const socket = new Socket();
  http.emit('upgrade', { url: '/browser/v1', method: 'GET', rawHeaders: ['Host', '127.0.0.1:23333', 'Origin', `chrome-extension://${extensionId}`],
    headers: { host: '127.0.0.1:23333', origin: `chrome-extension://${extensionId}` }, socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' } }, socket, Buffer.alloc(0));
  const code = JSON.parse(Buffer.from(bridge.beginPairing().code.slice(6), 'base64url').toString());
  const mac = (key, label, context) => crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(JSON.stringify([
    'mori-desk/browser/v1', label, 1, context.mode, context.credentialId, context.clientId,
    context.productId, context.instanceId, context.serverRunId, context.port, context.clientNonce, context.serverNonce,
  ])).digest('base64url');
  socket.input({ type: 'hello', v: 1, mode: 'pair', clientId: 'independent-client', browserRunId: 'independent-first-run',
    instanceId: code.instanceId, credentialId: code.pairingId, clientNonce: Buffer.alloc(32, 9).toString('base64url') });
  const challenge = received.at(-1);
  socket.input({ type: 'authenticate', proof: mac(code.secret, 'client-proof', challenge) });
  const credentialKey = mac(code.secret, 'credential', challenge);
  socket.input({ type: 'pair.confirm', proof: mac(credentialKey, 'pair-confirm', challenge) });
  return { bridge, socket, received, dataDir, now: () => now, advance: value => { now += value; },
    disk: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8')),
    close() { bridge.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

module.exports = { sourceRoot, productRoot, extensionRoot, ledger, IndependentClock, IndependentElement,
  independentDocument, createWorkerBoundary, createDesktopBoundary };
