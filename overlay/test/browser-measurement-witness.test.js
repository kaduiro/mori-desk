'use strict';

// Independent synthetic cases for the measurement component only. No product
// implementation, existing mock, fixture, or test helper is loaded here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const witness = require('../scripts/monitoring-independent-witness.js');

class Element {
  constructor(tag, attrs = {}, children = [], css = {}) {
    this.localName = tag; this.attrs = { ...attrs }; this.children = [];
    this.parentElement = null; this.css = { display: 'block', visibility: 'visible', ...css };
    for (const child of children) this.append(child);
    for (const key of ['textContent', 'innerText', 'innerHTML', 'outerHTML', 'value', 'title']) {
      Object.defineProperty(this, key, { get() { throw new Error('forbidden_content_read'); } });
    }
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  remove(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node.localName === 'html'; }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) {
      if (node.css.display === 'none' || node.css.visibility === 'hidden' || node.getAttribute('hidden') !== null) return [];
    }
    return this.css.display === 'contents' ? [] : [{ width: 120, height: 25 }];
  }
  matchesSimple(selector) {
    const tag = selector.match(/^[a-z][a-z0-9-]*/)?.[0];
    if (tag && this.localName !== tag) return false;
    for (const match of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
      if (match[2] === undefined ? this.getAttribute(match[1]) === null : this.getAttribute(match[1]) !== match[2]) return false;
    }
    return Boolean(tag || selector.startsWith('['));
  }
  querySelectorAll(selector) {
    const options = selector.split(',').map(s => s.trim()); const result = [];
    const visit = node => { for (const child of node.children) { if (options.some(s => child.matchesSimple(s))) result.push(child); visit(child); } };
    visit(this); return result;
  }
}

function documentFor(main) {
  const root = new Element('html', {}, [new Element('body', {}, [main])]);
  const events = new Map(); let observer;
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; this.disconnected = false; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const document = {
    documentElement: root, visibilityState: 'visible',
    querySelectorAll(selector) { return root.querySelectorAll(selector); },
    addEventListener(name, fn) { events.set(name, fn); },
    removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name); },
    defaultView: { getComputedStyle(element) { return element.css; }, MutationObserver: Observer }
  };
  for (const key of ['title', 'cookie', 'textContent', 'innerHTML']) {
    Object.defineProperty(document, key, { get() { throw new Error('forbidden_document_read'); } });
  }
  return { document, mutation() { observer.callback([{ type: 'attributes' }]); },
    visibility() { events.get('visibilitychange')?.(); }, observer: () => observer };
}

function chatPage({ running = true, owner = 'privateChat1', routeId = 'privateChat1' } = {}) {
  const display = new Element('section', { 'data-chatgpt-conversation-selection-target': owner });
  const message = display.append(new Element('article', { 'data-chatgpt-selection-conversation-id': owner }));
  const busy = message.append(new Element('span', { 'aria-busy': 'true' }, [], { display: running ? 'block' : 'none' }));
  const editor = new Element('div', { contenteditable: 'true', role: 'textbox' });
  const composer = new Element('div', { 'data-map-composer-conversation': owner }, [editor], { display: 'contents' });
  const stop = new Element('button', { 'aria-label': 'Stop generating' }, [], { display: running ? 'block' : 'none' });
  const form = new Element('form', {}, [composer, stop]);
  const main = new Element('main', {}, [display, form]);
  const doc = documentFor(main);
  const page = { ...doc, main, display, message, busy, editor, composer, form, stop,
    url: `https://chatgpt.com/c/${routeId}`, time: 100 };
  page.reader = options => witness.createStructureReader({ provider: 'chatgpt', document: page.document,
    readRoute: () => page.url, clock: () => page.time, ...options });
  return page;
}

function claudePage({ running = true } = {}) {
  const editor = new Element('div', { 'data-testid': 'chat-input', contenteditable: 'true', role: 'textbox' });
  const streaming = new Element('div', { 'data-is-streaming': running ? 'true' : 'false' });
  const stop = new Element('button', { 'aria-label': 'Stop' }, [], { display: running ? 'block' : 'none' });
  const root = new Element('section', { 'data-testid': 'bardhub-claudechat-root', 'data-conv-id': 'privateClaude1',
    'data-hub-ready': '1', 'data-hub-awaiting-creation': '0' }, [editor, streaming, stop]);
  const main = new Element('main', {}, [root]); const doc = documentFor(main);
  const page = { ...doc, main, root, editor, streaming, stop, time: 100, url: 'https://claude.ai/chat/privateClaude1' };
  page.reader = options => witness.createStructureReader({ provider: 'claude', document: page.document,
    readRoute: () => page.url, clock: () => page.time, ...options });
  return page;
}

test('UMD can load in a browser-like realm without require or product globals', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/monitoring-independent-witness.js'), 'utf8');
  const sandbox = { URL, TextDecoder, Uint8Array };
  vm.runInNewContext(source, sandbox);
  assert.equal(typeof sandbox.MoriIndependentWitness.createStructureReader, 'function');
  assert.equal(typeof sandbox.MoriIndependentWitness.createAckWitness, 'function');
});

test('independent ChatGPT structure handles contents composer and reads no content', () => {
  const page = chatPage(); const result = page.reader().sample();
  assert.equal(result.scopeKind, 'conversation'); assert.equal(result.state, 'running');
  assert.deepEqual(result.counts, { main: 1, display: 1, composer: 1, editor: 1, form: 1, stop: 1, busy: 1 });
  assert.equal(result.continuous1s, false);
  assert.doesNotMatch(JSON.stringify(result), /privateChat|https|conversation-selection-target/);
});

test('local screen owner is view only, never canonical and never an identity export', () => {
  const page = chatPage({ owner: 'local-chatgpt:privateLocal', routeId: 'privateStored' });
  const result = page.reader().sample();
  assert.equal(result.scopeKind, 'view'); assert.equal(result.state, 'running');
  assert.doesNotMatch(JSON.stringify(result), /privateLocal|privateStored|local-chatgpt/);
});

for (const [provider, makePage] of [['chatgpt', chatPage], ['claude', claudePage]]) {
  const invalidRoutes = {
    insecure_scheme(url) { url.protocol = 'http:'; },
    username(url) { url.username = 'privateCredential'; },
    password(url) { url.password = 'privateCredential'; },
    nondefault_port(url) { url.port = '8443'; },
    unlisted_host(url) { url.hostname = `${url.hostname}.invalid`; }
  };
  for (const [category, alter] of Object.entries(invalidRoutes)) {
    test(`${provider} rejects route category: ${category}`, () => {
      const page = makePage(); const url = new URL(page.url); alter(url); page.url = url.href;
      const result = page.reader().sample();
      assert.equal(result.state, 'unknown'); assert.equal(result.scopeKind, 'unknown');
      assert.doesNotMatch(JSON.stringify(result), /private|https?:|8443|\.invalid/);
    });
  }
  test(`${provider} accepts an explicit default HTTPS port`, () => {
    const page = makePage(); const url = new URL(page.url);
    page.url = `https://${url.hostname}:443${url.pathname}`;
    assert.equal(page.reader().sample().state, 'running');
  });
}

const chatNegatives = {
  duplicate_main(page) { page.main.parentElement.append(new Element('main')); },
  duplicate_owner(page) { page.main.append(new Element('section', { 'data-chatgpt-conversation-selection-target': 'privateChat1' })); },
  composer_mismatch(page) { page.composer.attrs['data-map-composer-conversation'] = 'differentPrivate'; },
  mixed_visible_message(page) { page.display.append(new Element('article', { 'data-chatgpt-selection-conversation-id': 'otherPrivate' })); },
  absent_editor(page) { page.composer.remove(page.editor); },
  duplicate_editor(page) { page.composer.append(new Element('textarea')); },
  detached_form(page) { page.main.remove(page.form); page.document.documentElement.children[0].append(page.form); },
  nested_dialog(page) { page.main.remove(page.form); page.main.append(new Element('div', { role: 'dialog' }, [page.form])); },
  only_stop(page) { page.busy.css.display = 'none'; },
  only_busy(page) { page.stop.css.display = 'none'; },
  unrelated_busy(page) { page.message.remove(page.busy); page.main.append(page.busy); },
  wrong_route(page) { page.url = 'https://chatgpt.com/c/otherPrivate'; },
  transparent_owner(page) { page.main.css.opacity = '0'; },
  aria_hidden_owner(page) { page.main.attrs['aria-hidden'] = 'true'; },
  background(page) { page.document.visibilityState = 'hidden'; }
};
for (const [name, alter] of Object.entries(chatNegatives)) {
  test(`ChatGPT refuses ambiguous or insufficient structure: ${name}`, () => {
    const page = chatPage(); alter(page);
    assert.equal(page.reader().sample().state, 'unknown');
  });
}

test('hidden old nodes do not become the current generation', () => {
  const page = chatPage({ running: false });
  page.display.append(new Element('article', { 'data-chatgpt-selection-conversation-id': 'oldPrivate' }, [], { display: 'none' }));
  page.form.append(new Element('button', { 'aria-label': 'Stop' }, [], { display: 'none' }));
  const result = page.reader().sample(); assert.equal(result.state, 'quiet');
  assert.equal(result.continuity, 'unknown'); assert.equal(result.continuous1s, false);
});

test('route-first DOM reuse is fenced until the actual owner structure changes', () => {
  const page = chatPage({ owner: 'local-chatgpt:privateLocal' }); const reader = page.reader();
  assert.equal(reader.sample().state, 'running');
  page.url = 'https://chatgpt.com/c/otherPrivate'; page.time += 100;
  assert.equal(reader.sample().reason, 'route_transition_unconfirmed');
  page.time += 100;
  assert.equal(reader.sample().state, 'unknown');
  page.display.attrs['data-chatgpt-conversation-selection-target'] = 'otherPrivate';
  page.composer.attrs['data-map-composer-conversation'] = 'otherPrivate';
  page.message.attrs['data-chatgpt-selection-conversation-id'] = 'otherPrivate';
  assert.equal(reader.sample().scopeKind, 'conversation');
});

test('positive polls, MO batching, and visibility never prove a continuous second', () => {
  const page = chatPage(); const reader = page.reader();
  reader.sample(); page.time += 2000;
  const repeat = reader.sample(); assert.equal(repeat.sameScope, true); assert.equal(repeat.continuous1s, false);
  page.mutation(); page.time += 100;
  const batch = reader.sample(); assert.equal(batch.uncertainty, 'mutation_batch'); assert.equal(batch.sameScope, false);
  page.visibility(); page.time += 100;
  assert.equal(reader.sample().uncertainty, 'visibility_changed');
  reader.dispose(); assert.equal(page.observer().disconnected, true);
  assert.equal(reader.sample().reason, 'disposed');
});

test('sample gaps and backward clocks reset comparison rather than bridging history', () => {
  const page = chatPage(); const reader = page.reader(); reader.sample();
  page.time += 15000; assert.equal(reader.sample().uncertainty, null);
  page.time += 15001; assert.equal(reader.sample().uncertainty, 'sample_gap');
  page.time = 1; const backwards = reader.sample();
  assert.equal(backwards.reason, 'clock_discontinuity'); assert.equal(backwards.interval, null);
  page.time = 2; const stillBackwards = reader.sample();
  assert.equal(stillBackwards.reason, 'clock_discontinuity'); assert.equal(stillBackwards.interval, null);
});

for (const failure of ['dom', 'end_clock']) {
  test(`a ${failure} exception preserves the successful start clock boundary`, () => {
    const page = chatPage(); const readings = [100, ...(failure === 'end_clock' ? [new Error('privateClockFailure')] : []), 10, 11, 101, 102];
    let failDom = failure === 'dom';
    const reader = page.reader({ clock() { const value = readings.shift(); if (value instanceof Error) throw value; return value; },
      readRoute() { if (failDom) { failDom = false; throw new Error('privateDomFailure'); } return page.url; } });
    const first = reader.sample(); assert.equal(first.state, 'unknown'); assert.equal(first.interval, null);
    if (failure === 'end_clock') assert.equal(first.reason, 'clock_discontinuity');
    for (let index = 0; index < 2; index++) {
      const backwards = reader.sample(); assert.equal(backwards.state, 'unknown');
      assert.equal(backwards.reason, 'clock_discontinuity'); assert.equal(backwards.interval, null);
    }
    const recovered = reader.sample(); assert.equal(recovered.state, 'running'); assert.deepEqual(recovered.interval, [1, 2]);
    assert.doesNotMatch(JSON.stringify([first, recovered]), /private/);
  });
}

test('a start clock exception cannot erase a previously valid clock boundary', () => {
  const page = chatPage(); const readings = [100, 101, new Error('privateClockFailure'), 10, 102, 103];
  const reader = page.reader({ clock() { const value = readings.shift(); if (value instanceof Error) throw value; return value; } });
  assert.equal(reader.sample().state, 'running');
  assert.equal(reader.sample().reason, 'clock_discontinuity');
  const backwards = reader.sample(); assert.equal(backwards.state, 'unknown'); assert.equal(backwards.interval, null);
  assert.deepEqual(reader.sample().interval, [2, 3]);
});

test('Claude reads root/composer ownership and structural streaming only', () => {
  const page = claudePage(); const reader = page.reader();
  assert.equal(reader.sample().state, 'running');
  page.streaming.attrs['data-is-streaming'] = 'false'; page.stop.css.display = 'none'; page.time += 100;
  const quiet = reader.sample(); assert.equal(quiet.state, 'quiet');
  assert.equal(quiet.continuity, 'unknown'); assert.doesNotMatch(JSON.stringify(quiet), /privateClaude/);
});
const claudeNegatives = {
  pending(page) { page.root.attrs['data-hub-awaiting-creation'] = '1'; },
  not_ready(page) { page.root.attrs['data-hub-ready'] = '0'; },
  wrong_route(page) { page.url = 'https://claude.ai/chat/otherPrivate'; },
  visible_shield(page) { page.main.append(new Element('div', { 'data-testid': 'chat-stale-nav-shield' })); },
  visible_skeleton(page) { page.root.append(new Element('div', { 'data-testid': 'chat-message-skeleton' })); },
  duplicate_root(page) { page.main.append(new Element('section', { 'data-testid': 'bardhub-claudechat-root' })); },
  wrong_editor(page) { page.editor.attrs.contenteditable = 'false'; },
  duplicate_stream(page) { page.root.append(new Element('div', { 'data-is-streaming': 'true' })); },
  only_stop(page) { page.streaming.attrs['data-is-streaming'] = 'false'; },
  unknown_stream_value(page) { page.streaming.attrs['data-is-streaming'] = 'uncertain'; }
};
for (const [name, alter] of Object.entries(claudeNegatives)) {
  test(`Claude refuses incomplete evidence: ${name}`, () => {
    const page = claudePage(); alter(page); assert.equal(page.reader().sample().state, 'unknown');
  });
}

function evidence({ terminal = false } = {}) {
  const scope = { kind: 'conversation', viewEpoch: 'view1', bindingEpoch: 'binding1', samplingEpoch: 'sampling1',
    workerEpoch: 'worker1', leaseId: 'lease1', documentId: 'document1', startUnobserved: false };
  const event = { type: 'scope.event', v: 1, schema: 2, kind: terminal ? 'terminal' : 'observation', eventId: 'privateEvent1', browserRunId: 'privateRun1',
    sessionId: 'privateSession1', provider: 'claude', tabId: 41, pageInstanceId: 'privatePage1', routeRevision: 3,
    conversationRef: 'claude:privateConversation1', turnId: 'privateTurn1', generation: 2, sequence: 7,
    phase: terminal ? 'settled' : 'running', outcome: terminal ? 'unverified' : null,
    observation: 'fresh', observedAt: 101, replay: false, scope };
  const row = { id: 'local/private-row:1', clientId: 'privateClient1', browserRunId: event.browserRunId,
    sessionId: event.sessionId, provider: event.provider, tabId: event.tabId, pageInstanceId: event.pageInstanceId,
    routeRevision: event.routeRevision, conversationRef: event.conversationRef, currentTurnId: event.turnId,
    generation: event.generation, lastSequence: event.sequence, lastObservationAt: event.observedAt,
    phase: event.phase, outcome: event.outcome, observation: event.observation, scope: { ...scope },
    retired: false, acceptedEventId: event.eventId };
  const ack = { type: 'scope.event.ack', schema: 2, eventId: event.eventId, browserRunId: event.browserRunId,
    sessionId: event.sessionId, sequence: event.sequence, disposition: 'committed_current', duplicate: false,
    proof: 'privateOpaqueProof', reason: null };
  const context = { authenticated: true, independentWire: true, independentStore: true, clientId: row.clientId,
    browserRunId: event.browserRunId, connectionId: 'privateConnection1', currentConnectionId: 'privateConnection1',
    serverRunId: 'privateServer1', currentServerRunId: 'privateServer1', scope: { ...scope } };
  const point = (start, end) => ({ clockGeneration: 'privateClock1', start, end });
  const intervals = { durable: point(10, 11), ackSent: point(12, 13), ackFrame: point(14, 15), ackValidated: point(16, 17) };
  const receipts = terminal ? [{ id: row.id, eventId: event.eventId, turnId: event.turnId,
    generation: event.generation, observedAt: event.observedAt, outcome: event.outcome, noticeSequence: 4 }] : [];
  return { ack, expectedEvent: event, persistedSnapshot: { version: 2, sessions: [row], receipts }, context, intervals };
}
function inspect(item, instance = witness.createAckWitness()) {
  return instance.inspect({ ...item, wireAck: typeof item.ack === 'string' ? item.ack : JSON.stringify(item.ack) });
}

test('actual ACK grammar + independent stored current event + proven send order can pass ACK evidence only', () => {
  const result = inspect(evidence());
  assert.equal(result.current, true); assert.equal(result.pass, true); assert.equal(result.formalAcceptance, false);
  assert.deepEqual(result.durableToValidationInterval, [5, 7]);
  assert.doesNotMatch(JSON.stringify(result), /private|local\/|lease1|document1|claude:/);
});

test('terminal committed_current requires both current update and its exact receipt', () => {
  const item = evidence({ terminal: true }); const result = inspect(item);
  assert.equal(result.current, true); assert.equal(result.terminalDurable, true);
  item.persistedSnapshot.receipts = []; assert.equal(inspect(item).category, 'terminal_receipt_missing');
});

test('a stored terminal cannot become a current observation by replacing only event kind', () => {
  const item = evidence({ terminal: true }); item.expectedEvent.kind = 'observation';
  const result = inspect(item); assert.equal(result.category, 'event_kind_conflict');
  for (const flag of ['current', 'pass', 'storeMatched', 'terminalDurable']) assert.equal(result[flag], false);
});

test('a same-eventId receipt on another row is contradictory, not current evidence', () => {
  const item = evidence({ terminal: true }); item.expectedEvent.kind = 'observation';
  item.persistedSnapshot.receipts[0].id = 'privateOtherRow';
  assert.equal(inspect(item).category, 'event_kind_conflict');
});

test('an unrelated older terminal receipt does not contradict the new observation', () => {
  const item = evidence(); const old = evidence({ terminal: true }).persistedSnapshot.receipts[0];
  old.eventId = 'privateOldEvent'; item.persistedSnapshot.receipts.push(old);
  assert.equal(inspect(item).pass, true);
});

const malformedWireIds = { punctuation: 'private/id', too_long: 'a'.repeat(129), empty: '', numeric: 1,
  line_terminator: 'privateId\n', unicode: 'private\u00c9' };
for (const field of ['eventId', 'browserRunId', 'sessionId', 'proof']) {
  for (const [category, value] of Object.entries(malformedWireIds)) {
    test(`ACK strict ID grammar rejects ${field}/${category}`, () => {
      const item = evidence(); item.ack[field] = value; const result = inspect(item);
      assert.equal(result.category, 'ack_schema_invalid'); assert.equal(result.pass, false);
    });
  }
}
for (const field of ['eventId', 'browserRunId', 'sessionId', 'pageInstanceId', 'turnId']) {
  for (const [category, value] of Object.entries(malformedWireIds)) {
    test(`expected event strict ID grammar rejects ${field}/${category}`, () => {
      const item = evidence(); item.expectedEvent[field] = value; const result = inspect(item);
      assert.equal(result.category, 'expected_event_invalid'); assert.equal(result.pass, false);
    });
  }
}

test('128-character wire IDs pass while composite row ID and route keep their separate grammar', () => {
  const item = evidence(); const boundary = 'a'.repeat(128);
  for (const field of ['eventId', 'browserRunId', 'sessionId']) {
    item.ack[field] = boundary; item.expectedEvent[field] = boundary;
  }
  item.ack.proof = boundary; item.expectedEvent.pageInstanceId = boundary; item.expectedEvent.turnId = boundary;
  Object.assign(item.persistedSnapshot.sessions[0], { browserRunId: boundary, sessionId: boundary,
    pageInstanceId: boundary, currentTurnId: boundary, acceptedEventId: boundary });
  item.context.browserRunId = boundary;
  assert.equal(inspect(item).pass, true);
});

for (const [field, limit] of [['sessions', 200], ['receipts', 4096]]) {
  test(`snapshot rejects more than ${limit} ${field} before row interpretation`, () => {
    const item = evidence(); item.persistedSnapshot[field] = Array.from({ length: limit + 1 }, () => ({}));
    const result = inspect(item); assert.equal(result.category, 'snapshot_invalid'); assert.equal(result.pass, false);
  });
  test(`snapshot permits the exact ${field} bound without relaxing event identity`, () => {
    const item = evidence();
    if (field === 'sessions') {
      const extra = { ...item.persistedSnapshot.sessions[0], sessionId: 'privateOtherSession' };
      item.persistedSnapshot.sessions.push(...Array.from({ length: limit - 1 }, () => ({ ...extra })));
    } else {
      const extra = { ...evidence({ terminal: true }).persistedSnapshot.receipts[0], eventId: 'privateOldEvent' };
      item.persistedSnapshot.receipts.push(...Array.from({ length: limit }, () => ({ ...extra })));
    }
    assert.equal(inspect(item).pass, true);
  });
}

test('committed_receipt without historical payload binding remains unverified', () => {
  const item = evidence({ terminal: true }); item.ack.disposition = 'committed_receipt'; item.ack.proof = null;
  item.persistedSnapshot.sessions[0].acceptedEventId = 'olderPrivateEvent';
  item.persistedSnapshot.sessions[0].lastSequence = 99;
  const result = inspect(item);
  assert.equal(result.category, 'receipt_identity_unverified'); assert.equal(result.terminalDurable, false);
  assert.equal(result.storeMatched, false); assert.equal(result.orderProven, false);
  assert.equal(result.current, false); assert.equal(result.pass, false);
});

for (const [field, value] of [['provider', 'chatgpt'], ['tabId', 99], ['pageInstanceId', 'privateOtherPage'],
  ['routeRevision', 9], ['conversationRef', 'privateOtherRoute']]) {
  test(`same eventId receipt cannot bind conflicting historical ${field}`, () => {
    const item = evidence({ terminal: true }); item.ack.disposition = 'committed_receipt'; item.ack.proof = null;
    item.expectedEvent[field] = value;
    const result = inspect(item); assert.equal(result.category, 'receipt_identity_unverified');
    for (const flag of ['terminalDurable', 'storeMatched', 'pass', 'current', 'orderProven']) assert.equal(result[flag], false);
  });
}
test('same eventId receipt cannot bind a conflicting historical scope', () => {
  const item = evidence({ terminal: true }); item.ack.disposition = 'committed_receipt'; item.ack.proof = null;
  item.expectedEvent.scope.leaseId = 'privateOtherLease';
  const result = inspect(item); assert.equal(result.category, 'receipt_identity_unverified');
  assert.equal(result.terminalDurable, false); assert.equal(result.storeMatched, false);
});

const ackNegatives = {
  wrong_event_type(item) { item.expectedEvent.type = 'other.event'; },
  wrong_event_version(item) { item.expectedEvent.v = 2; },
  wrong_event_schema(item) { item.expectedEvent.schema = 1; },
  missing_event_type(item) { delete item.expectedEvent.type; },
  missing_event_version(item) { delete item.expectedEvent.v; },
  missing_event_schema(item) { delete item.expectedEvent.schema; },
  other_provider(item) { item.persistedSnapshot.sessions[0].provider = 'chatgpt'; },
  other_event(item) { item.ack.eventId = 'privateOtherEvent'; },
  other_sequence(item) { item.ack.sequence++; },
  other_session(item) { item.ack.sessionId = 'privateOtherSession'; },
  other_browser_run(item) { item.ack.browserRunId = 'privateOtherRun'; },
  other_connection(item) { item.context.currentConnectionId = 'privateNewConnection'; },
  other_server(item) { item.context.currentServerRunId = 'privateNewServer'; },
  other_scope(item) { item.context.scope.samplingEpoch = 'sampling2'; },
  other_stored_scope(item) { item.persistedSnapshot.sessions[0].scope.documentId = 'document2'; },
  stale_sequence(item) { item.persistedSnapshot.sessions[0].lastSequence++; },
  wrong_turn(item) { item.persistedSnapshot.sessions[0].currentTurnId = 'privateOtherTurn'; },
  wrong_generation(item) { item.persistedSnapshot.sessions[0].generation++; },
  wrong_route_revision(item) { item.persistedSnapshot.sessions[0].routeRevision++; },
  wrong_page(item) { item.persistedSnapshot.sessions[0].pageInstanceId = 'privateOtherPage'; },
  wrong_observed_at(item) { item.persistedSnapshot.sessions[0].lastObservationAt++; },
  retired(item) { item.persistedSnapshot.sessions[0].retired = true; },
  no_row(item) { item.persistedSnapshot.sessions = []; },
  duplicate_row(item) { item.persistedSnapshot.sessions.push({ ...item.persistedSnapshot.sessions[0] }); },
  fake_current_store(item) { item.persistedSnapshot.sessions[0].acceptedEventId = 'privateOldEvent'; },
  replay(item) { item.expectedEvent.replay = true; },
  duplicate(item) { item.ack.duplicate = true; },
  durable_duplicate(item) { item.ack.disposition = 'duplicate_durable'; },
  ignored_order(item) { item.ack.disposition = 'ignored_order'; },
  proof_missing(item) { item.ack.proof = null; },
  capacity_reason(item) { item.ack.reason = 'desktop_capacity'; },
  unauthenticated(item) { item.context.authenticated = false; },
  product_parser_only(item) { item.context.independentWire = false; },
  product_store_only(item) { item.context.independentStore = false; },
  initialized_row_not_observed(item) { item.expectedEvent.observedAt = 0; item.persistedSnapshot.sessions[0].lastObservationAt = 0; },
  later_store_read_only(item) { item.intervals.durable = { clockGeneration: 'privateClock1', start: 50, end: 51 }; },
  missing_send_boundary(item) { delete item.intervals.ackSent; },
  delayed_premature_ack(item) { item.intervals.ackSent = { clockGeneration: 'privateClock1', start: 1, end: 2 }; },
  overlapping_intervals(item) { item.intervals.ackSent.start = 10; },
  clock_generation_change(item) { item.intervals.ackFrame.clockGeneration = 'privateClock2'; },
  negative_clock(item) { item.intervals.durable.start = -1; },
  noncurrent_kind(item) { item.expectedEvent.kind = 'gap'; },
  unknown_ack_key(item) { item.ack.extra = 'privateSecret'; },
  old_schema(item) { item.ack.schema = 1; },
  numeric_scope_id(item) { item.expectedEvent.scope.viewEpoch = 1; },
  null_scope_id(item) { item.expectedEvent.scope.bindingEpoch = null; },
  slash_scope_id(item) { item.expectedEvent.scope.leaseId = 'private/lease'; },
  extra_scope_key(item) { item.expectedEvent.scope.title = 'privateSecret'; },
  receipt_for_nonteminal(item) { item.ack.disposition = 'committed_receipt'; item.ack.proof = null; }
};
for (const [name, alter] of Object.entries(ackNegatives)) {
  test(`independent ACK negative cannot become current/pass: ${name}`, () => {
    const item = evidence(); alter(item); const result = inspect(item);
    assert.equal(result.pass, false); assert.equal(result.current, false);
    assert.doesNotMatch(JSON.stringify(result), /private|local\/|claude:/);
  });
}

test('missing independent send time preserves match evidence, not success', () => {
  const item = evidence(); delete item.intervals.ackSent; const result = inspect(item);
  assert.equal(result.category, 'order_unverified'); assert.equal(result.storeMatched, true);
  assert.equal(result.pass, false);
});

test('same actual frame repeated without duplicate flag is caught in bounded witness memory', () => {
  const item = evidence(); const instance = witness.createAckWitness({ maxEntries: 1 });
  assert.equal(inspect(item, instance).pass, true);
  assert.equal(inspect(item, instance).category, 'repeated_wire_ack');
  const other = evidence(); other.expectedEvent.eventId = 'privateEvent2'; other.ack.eventId = 'privateEvent2';
  other.persistedSnapshot.sessions[0].acceptedEventId = 'privateEvent2';
  assert.equal(inspect(other, instance).category, 'witness_capacity');
  instance.dispose(); assert.equal(inspect(item, instance).category, 'disposed');
});

test('insufficient first evidence cannot turn into freshness when its ACK is replayed later', () => {
  const item = evidence(); const instance = witness.createAckWitness();
  delete item.intervals.ackSent;
  assert.equal(inspect(item, instance).category, 'order_unverified');
  item.intervals.ackSent = { clockGeneration: 'privateClock1', start: 12, end: 13 };
  const later = inspect(item, instance);
  assert.equal(later.category, 'repeated_wire_ack'); assert.equal(later.pass, false);
});

test('an explicit NACK does not poison a later legitimate first accepted ACK', () => {
  const item = evidence(); const instance = witness.createAckWitness(); const ack = item.ack;
  item.ack = { type: 'scope.event.nack', schema: 2, eventId: ack.eventId, browserRunId: ack.browserRunId,
    sessionId: ack.sessionId, sequence: ack.sequence, reason: 'desktop_capacity' };
  assert.equal(inspect(item, instance).category, 'nack');
  item.ack = ack; assert.equal(inspect(item, instance).pass, true);
});

test('receipt borrowed from another event or malformed notice does not establish a terminal', () => {
  for (const change of [r => { r.eventId = 'privateOtherEvent'; }, r => { r.noticeSequence = 0; }, r => { r.outcome = 'error'; }]) {
    const item = evidence({ terminal: true }); change(item.persistedSnapshot.receipts[0]);
    assert.equal(inspect(item).category, 'terminal_receipt_missing');
  }
});

test('NACK and malformed/raw product object are never accepted as a successful ACK', () => {
  const item = evidence(); item.ack = { type: 'scope.event.nack', schema: 2, eventId: item.expectedEvent.eventId,
    browserRunId: item.expectedEvent.browserRunId, sessionId: item.expectedEvent.sessionId, sequence: 7, reason: 'desktop_capacity' };
  assert.equal(inspect(item).category, 'nack');
  const instance = witness.createAckWitness();
  assert.equal(instance.inspect({ ...evidence(), wireAck: evidence().ack }).category, 'ack_schema_invalid');
  assert.equal(instance.inspect({ wireAck: '{privateMalformed' }).category, 'ack_schema_invalid');
  assert.equal(instance.inspect({ wireAck: new Uint8Array([255, 254]) }).category, 'ack_schema_invalid');
});

test('metadata getters are not invoked and exceptions cannot leak their text', () => {
  const item = evidence();
  for (const record of [item.expectedEvent, item.persistedSnapshot, item.persistedSnapshot.sessions[0]]) {
    for (const key of ['title', 'preview', 'credential', 'html']) Object.defineProperty(record, key, { enumerable: true,
      get() { throw new Error('privateForbiddenMetadata'); } });
  }
  assert.equal(inspect(item).pass, true);
  Object.defineProperty(item.context, 'connectionId', { get() { throw new Error('privateForbiddenIdentity'); } });
  const result = inspect(item); assert.equal(result.pass, false); assert.doesNotMatch(JSON.stringify(result), /privateForbidden/);
});
