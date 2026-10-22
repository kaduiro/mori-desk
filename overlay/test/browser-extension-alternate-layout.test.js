/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chatgpt = require('../extensions/browser-bridge/adapters/chatgpt');
const utils = require('../extensions/browser-bridge/provider-utils');
const { createController } = require('../extensions/browser-bridge/observation-controller');
const coordinator = require('../extensions/browser-bridge/session-coordinator');
const outbox = require('../extensions/browser-bridge/outbox');
const protocol = require('../src/browser-bridge-protocol');
const { createBrowserSessionStore } = require('../src/browser-session-store');
const { mergeHudSnapshot } = require('../src/mori-desktop-snapshot');
const { getMoriHudStatus } = require('../src/mori-hud-status');

const CHAT_URL = 'https://chatgpt.com/c/synthetic-conversation';

// Synthetic DOM only: the user's counts establish control presence/absence,
// not a production HTML structure. Stable element identities model overlapping
// selectors correctly. Unsupported selector syntax throws instead of silently
// making a more permissive match. Page text, HTML, and input values are unreadable.
function matchesSimple(element, selector) {
  let rest = selector.trim();
  const tag = rest.match(/^[a-z][a-z0-9-]*/i)?.[0];
  if (tag) {
    if (element.tagName !== tag.toUpperCase()) return false;
    rest = rest.slice(tag.length);
  }
  while (rest.length) {
    const id = rest.match(/^#([a-z0-9_-]+)/i);
    if (id) {
      if (element.getAttribute('id') !== id[1]) return false;
      rest = rest.slice(id[0].length);
      continue;
    }
    const attribute = rest.match(/^\[([a-z0-9-]+)(?:="([^"]*)")?\]/i);
    if (!attribute) throw new Error(`Unsupported synthetic selector: ${selector}`);
    const value = element.getAttribute(attribute[1]);
    if (value === null || (attribute[2] !== undefined && value !== attribute[2])) return false;
    rest = rest.slice(attribute[0].length);
  }
  return true;
}

class SyntheticElement {
  constructor(tag, attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.children = children;
    this.parentElement = null;
    for (const child of children) child.parentElement = this;
  }
  get hidden() { return Object.hasOwn(this.attributes, 'hidden'); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selectors) { return selectors.split(',').some(selector => matchesSimple(this, selector)); }
  querySelectorAll(selectors) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selectors)) found.push(child);
      found.push(...child.querySelectorAll(selectors));
    }
    return found;
  }
  querySelector(selectors) { return this.querySelectorAll(selectors)[0] ?? null; }
  closest(selectors) {
    for (let current = this; current; current = current.parentElement) {
      if (current.matches(selectors)) return current;
    }
    return null;
  }
  getClientRects() {
    for (let current = this; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return [];
    }
    return [{}];
  }
  get textContent() { throw new Error('Page text must not be read'); }
  get innerText() { throw new Error('Page text must not be read'); }
  get innerHTML() { throw new Error('Page HTML must not be read'); }
  get outerHTML() { throw new Error('Page HTML must not be read'); }
  get value() { throw new Error('Input values must not be read'); }
}

const element = (tag, attributes, children) => new SyntheticElement(tag, attributes, children);

function documentWith(children) {
  const body = element('body', {}, children);
  const doc = {
    body, readyState: 'complete',
    querySelectorAll: selectors => body.querySelectorAll(selectors),
    querySelector: selectors => body.querySelector(selectors),
    get cookie() { throw new Error('Cookies must not be read'); },
    get title() { throw new Error('Page titles must not be read'); },
  };
  function attach(node) {
    node.ownerDocument = doc;
    for (const child of node.children) attach(child);
  }
  attach(body);
  return doc;
}

function alternate({ editorType = 'editable', editorCount = 1, editorAttributes = {}, stopLabels = ['Stop'], busyCount = 1,
  hiddenEditor = false, hiddenStop = false, hiddenBusy = false, assistant = false } = {}) {
  const editors = Array.from({ length: editorCount }, () => {
    const attributes = editorType === 'textarea' ? {}
      : editorType === 'role-only' ? { role: 'textbox' }
        : { contenteditable: editorType === 'plaintext' ? 'plaintext-only' : 'true', role: 'textbox' };
    return element(editorType === 'textarea' ? 'textarea' : 'div', {
      ...attributes, ...editorAttributes, ...(hiddenEditor ? { hidden: '' } : {}), 'data-private': 'PRIVATE_PROMPT',
    });
  });
  const stops = stopLabels.map(label => element('button', {
    'aria-label': label, ...(hiddenStop ? { hidden: '' } : {}),
  }, [element('span')]));
  const busy = Array.from({ length: busyCount }, () => element('div', {
    'aria-busy': 'true', ...(hiddenBusy ? { hidden: '' } : {}),
  }));
  // No common form is assumed. These are synthetic placements, not captured HTML.
  const doc = documentWith([
    element('main', {}, [...busy, ...(assistant ? [element('article', {
      'data-message-author-role': 'assistant', 'data-private': 'PRIVATE_REPLY',
    })] : [])]),
    element('footer', {}, editors), element('aside', {}, stops),
  ]);
  return { doc, editors, stops };
}

const quiet = overrides => alternate({ stopLabels: [], busyCount: 0, ...overrides });

function legacy({ running = true, assistant = false } = {}) {
  return documentWith([
    element('div', { id: 'prompt-textarea', contenteditable: 'true' }),
    ...(running ? [element('button', { 'data-testid': 'stop-button' })] : []),
    ...(assistant ? [element('article', { 'data-message-author-role': 'assistant' })] : []),
  ]);
}

function observe(doc, url = CHAT_URL) {
  const result = chatgpt.observe(doc, url);
  assert.ok(Object.values(result).every(value => value === null || ['boolean', 'string'].includes(typeof value)),
    'Provider observations contain only booleans and fixed categories, never DOM nodes');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  return result;
}

function integration(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mori-alternate-layout-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let clock = 1000000;
  let id = 0;
  let state = coordinator.newState('browser-run');
  let journal = { v: 1, events: [] };
  const tabs = new Map();
  const allEvents = [];
  const notices = [];
  const uuid = () => `synthetic-${++id}`;
  const store = createBrowserSessionStore({ dataDir, now: () => clock, onNotice: value => notices.push(value) });
  store.connect('client-1', 'browser-run');
  return {
    store, notices, allEvents, dataDir,
    now: () => clock,
    advance(ms) { clock += ms; },
    get journal() { return journal; },
    sample(tabId, doc) {
      if (!tabs.has(tabId)) tabs.set(tabId, { controller: createController({ uuid }), sequence: 0 });
      const tab = tabs.get(tabId);
      const signal = observe(doc);
      const sample = tab.controller.sample(signal, clock);
      const reduced = coordinator.reduceObservation(state, {
        type: 'mori.observation', v: 1, pageInstanceId: `page-${tabId}`,
        contentSequence: ++tab.sequence, observedAt: clock, ...sample,
      }, { tabId, documentId: `document-${tabId}`, route: utils.routeForUrl(CHAT_URL) }, { uuid, now: clock });
      state = reduced.state;
      assert.notEqual(reduced.diagnostic, 'invalid_observation');
      const durable = reduced.events.filter(event => ['terminal', 'closed'].includes(event.kind));
      journal = outbox.append(journal, durable);
      for (const event of reduced.events) {
        assert.deepEqual(protocol.validateEvent(event), event);
        allEvents.push(event);
        store.ingest('client-1', event);
      }
      assert.doesNotMatch(JSON.stringify({ sample, events: allEvents, journal }), /PRIVATE_|https:/);
      return { signal, sample, events: reduced.events };
    },
    hud() {
      return mergeHudSnapshot({ sessions: [], orderedIds: [], hudTotalNonIdle: 0,
        moriBrowserStatus: { state: 'ready', dnd: false } }, store.getSnapshot());
    },
  };
}

test('synthetic alternate controls create distinct HUD rows and one durable unverified receipt per observed turn', t => {
  const f = integration(t);
  const idle = f.sample(1, quiet().doc);
  assert.equal(idle.events.length, 1);
  assert.equal(idle.events[0].phase, 'idle');
  assert.equal(idle.events[0].turnId, null);
  assert.equal(f.hud().sessions.length, 1);
  assert.equal(f.notices.length, 0);
  assert.equal(getMoriHudStatus(f.hud()), null);

  const first = f.sample(1, alternate().doc);
  assert.equal(first.signal.hasAssistant, false);
  assert.equal(first.signal.generationSignal, 'short_stop_busy');
  assert.equal(first.sample.status, 'running');
  const firstRow = f.store.getSnapshot()[0];
  assert.equal(firstRow.status, 'generating');
  assert.equal(firstRow.state, 'working');
  assert.equal(f.hud().hudTotalNonIdle, 1);
  assert.equal(getMoriHudStatus(f.hud()), null);

  f.sample(2, alternate({ stopLabels: ['停止'] }).doc);
  assert.equal(f.hud().sessions.length, 2);
  assert.equal(f.hud().hudTotalNonIdle, 2);
  const secondRow = f.store.getSnapshot().find(row => row.tabId === 2);
  assert.notEqual(firstRow.id, secondRow.id);
  assert.equal(firstRow.conversationRef, secondRow.conversationRef);

  f.advance(10);
  assert.equal(f.sample(1, quiet().doc).sample.status, 'running');
  f.advance(799);
  assert.equal(f.sample(1, quiet().doc).sample.status, 'running');
  f.advance(1);
  const settled = f.sample(1, quiet().doc);
  assert.equal(settled.sample.status, 'settled');
  assert.equal(settled.sample.outcome, 'unverified');
  assert.equal(settled.events.filter(event => event.kind === 'terminal').length, 1);
  const receipt = settled.events.find(event => event.kind === 'terminal');
  const settledRow = f.store.getSnapshot().find(row => row.tabId === 1);
  assert.equal(settledRow.statusLabel, '回答を確認');
  assert.equal(settledRow.requiresCompletionAck, true);
  assert.equal(settledRow.unreadCount, 1);
  assert.equal(f.notices.length, 1);
  assert.equal(f.journal.events.length, 1);

  f.advance(1000);
  assert.equal(f.sample(1, quiet().doc).events.some(event => event.kind === 'terminal'), false);
  assert.equal(f.store.ingest('client-1', { ...receipt, replay: true }).duplicate, true);
  assert.equal(f.notices.length, 1);
  const restored = createBrowserSessionStore({ dataDir: f.dataDir, now: f.now });
  assert.equal(restored.getSnapshot().find(row => row.tabId === 1).unreadCount, 1,
    'The real session store preserves the receipt on disk');

  f.advance(1000);
  const next = f.sample(1, alternate({ stopLabels: ['停止する'] }).doc);
  const nextRow = f.store.getSnapshot().find(row => row.tabId === 1);
  assert.equal(next.sample.status, 'running');
  assert.notEqual(next.sample.generationToken, first.sample.generationToken);
  assert.equal(nextRow.id, firstRow.id);
  assert.equal(nextRow.generation, firstRow.generation + 1);
  assert.notEqual(nextRow.currentTurnId, settledRow.currentTurnId);
  assert.equal(nextRow.pendingNotice.turnId, settledRow.currentTurnId);
  assert.equal(nextRow.requiresCompletionAck, true);
  assert.equal(nextRow.unreadCount, 1);
  assert.equal(f.hud().sessions.length, 2);
  assert.equal(f.allEvents.some(event => event.outcome === 'completed'), false);
});

test('synthetic alternate editor forms and short stop labels use fixed attributes without reading text', () => {
  for (const editorType of ['editable', 'plaintext', 'textarea']) {
    for (const label of ['Stop', '停止', '停止する']) {
      const fixture = alternate({ editorType, stopLabels: [label] });
      const result = observe(fixture.doc);
      assert.equal(result.generating, true, `${editorType} / ${label}`);
      assert.equal(result.ready, true);
      assert.equal(result.hasAssistant, false);
      assert.equal(result.controlsIdle, false);
      assert.equal(chatgpt.isStopTarget(fixture.stops[0].children[0], fixture.doc, CHAT_URL), true);
    }
  }
  const fixture = alternate();
  assert.equal(fixture.doc.querySelectorAll('[contenteditable="true"]')[0],
    fixture.doc.querySelectorAll('[role="textbox"]')[0], 'Overlapping selector results keep DOM identity');
});

test('synthetic incomplete, ambiguous, or hidden alternate controls cannot start a HUD session', t => {
  const cases = [
    ['busy only', { stopLabels: [] }],
    ['short stop only', { busyCount: 0 }],
    ['no editor', { editorCount: 0 }],
    ['role textbox alone', { editorType: 'role-only' }],
    ['read-only editable attribute', { editorAttributes: { readonly: '' } }],
    ['read-only textarea attribute', { editorType: 'textarea', editorAttributes: { readonly: '' } }],
    ['ARIA read-only editor', { editorAttributes: { 'aria-readonly': 'true' } }],
    ['two editors', { editorCount: 2 }],
    ['two short stop controls', { stopLabels: ['Stop', '停止'] }],
    ['hidden editor', { hiddenEditor: true }],
    ['hidden stop control', { hiddenStop: true }],
    ['hidden busy signal', { hiddenBusy: true }],
    ['non-allowlisted stop label', { stopLabels: ['Stop reading aloud'] }],
  ];
  const f = integration(t);
  cases.forEach(([name, options], index) => {
    const fixture = alternate(options);
    const result = f.sample(index + 1, fixture.doc);
    assert.equal(result.signal.generating, false, name);
    assert.equal(result.signal.supported, false, name);
    assert.equal(result.sample.status, 'unknown', name);
    assert.equal(result.events.length, 0, name);
    for (const stop of fixture.stops) assert.equal(chatgpt.isStopTarget(stop, fixture.doc, CHAT_URL), false, name);
  });
  assert.equal(f.hud().sessions.length, 0);
  assert.equal(f.notices.length, 0);
  const propertyOnly = alternate({ editorType: 'textarea' });
  propertyOnly.editors[0].readOnly = true;
  assert.equal(observe(propertyOnly.doc).generating, false);
});

test('synthetic alternate stop targeting excludes competing legacy controls and preserves an observed interruption', () => {
  const fixture = alternate();
  const legacyStop = element('button', { 'data-testid': 'stop-button' });
  fixture.doc.body.children.push(legacyStop);
  legacyStop.parentElement = fixture.doc.body;
  assert.equal(chatgpt.isStopTarget(fixture.stops[0], fixture.doc, CHAT_URL), false,
    'A short stop is not the accepted generation control when a legacy stop is present');
  const controller = createController({ uuid: () => 'turn-interrupted' });
  const active = alternate();
  controller.sample(observe(active.doc), 1000);
  assert.equal(chatgpt.isStopTarget(active.stops[0].children[0], active.doc, CHAT_URL), true);
  controller.stopRequested();
  controller.sample(observe(quiet().doc), 1100);
  assert.equal(controller.sample(observe(quiet().doc), 1900).outcome, 'interrupted');
});

test('synthetic alternate controls remain constrained to allowed ChatGPT origins and conversation routes', () => {
  const fixture = alternate();
  for (const url of ['https://example.com/c/synthetic', 'http://chatgpt.com/c/synthetic',
    'https://chatgpt.com.evil.test/c/synthetic', 'https://claude.ai/chat/synthetic',
    'https://chatgpt.com/g/g-custom/edit']) {
    assert.equal(observe(fixture.doc, url).supported, false, url);
    assert.equal(chatgpt.isStopTarget(fixture.stops[0], fixture.doc, url), false, url);
  }
});

test('synthetic alternate settlement rejects partial disappearance, lost editors, and ambiguity even with an assistant marker', () => {
  const cases = [
    ['stop remains', { busyCount: 0 }],
    ['busy remains', { stopLabels: [] }],
    ['editor lost', { editorCount: 0, stopLabels: [], busyCount: 0 }],
    ['editor hidden', { hiddenEditor: true, stopLabels: [], busyCount: 0 }],
    ['ambiguous editors', { editorCount: 2, stopLabels: [], busyCount: 0 }],
    ['ambiguous stops', { stopLabels: ['Stop', '停止'], busyCount: 0 }],
  ];
  for (const [name, options] of cases) {
    const controller = createController({ uuid: () => 'turn-alternate' });
    controller.sample(observe(alternate().doc), 1000);
    const uncertain = observe(alternate({ ...options, assistant: true }).doc);
    assert.notEqual(controller.sample(uncertain, 2000).status, 'settled', name);
    const later = controller.sample(uncertain, 10000);
    assert.equal(later.status, 'unknown', name);
    assert.equal(later.outcome, null, name);
  }
});

test('synthetic alternate reappearance and uncertainty restart the settlement debounce', () => {
  const controller = createController({ uuid: () => 'turn-alternate' });
  const running = observe(alternate().doc);
  const idle = observe(quiet().doc);
  controller.sample(running, 1000);
  controller.sample(idle, 1100);
  assert.equal(controller.sample(running, 1700).status, 'running');
  controller.sample(idle, 1800);
  assert.equal(controller.sample(idle, 2599).status, 'running');
  assert.equal(controller.sample({ supported: false }, 2600).status, 'unknown');
  assert.equal(controller.sample(idle, 10000).status, 'running');
  assert.equal(controller.sample(idle, 10799).status, 'running');
  assert.equal(controller.sample(idle, 10800).outcome, 'unverified');
});

test('synthetic legacy generations do not acquire alternate settlement eligibility in the middle of a turn', () => {
  const controller = createController({ uuid: () => 'turn-legacy' });
  assert.equal(controller.sample(observe(legacy()), 1000).status, 'running');
  assert.equal(controller.sample(observe(alternate().doc), 1500).status, 'running');
  const legacyQuiet = observe(legacy({ running: false }));
  assert.equal(legacyQuiet.hasAssistant, false);
  controller.sample(legacyQuiet, 2000);
  assert.equal(controller.sample(legacyQuiet, 10000).status, 'unknown');
  const withAssistant = observe(legacy({ running: false, assistant: true }));
  controller.sample(withAssistant, 10100);
  assert.equal(controller.sample(withAssistant, 10900).outcome, 'unverified');
});

test('synthetic controller reset removes alternate eligibility and user interruption from the previous document', () => {
  const controller = createController({ uuid: () => 'turn-after-reset' });
  controller.sample(observe(alternate().doc), 1000);
  controller.stopRequested();
  controller.reset();
  assert.deepEqual(controller.sample(observe(quiet().doc), 5000),
    { status: 'idle', generationToken: null, outcome: null });
  controller.sample(observe(legacy()), 6000);
  controller.sample(observe(legacy({ running: false })), 7000);
  assert.equal(controller.sample(observe(legacy({ running: false })), 8000).status, 'unknown');
  const withAssistant = observe(legacy({ running: false, assistant: true }));
  controller.sample(withAssistant, 9000);
  assert.equal(controller.sample(withAssistant, 9800).outcome, 'unverified');
});
