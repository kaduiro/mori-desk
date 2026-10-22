/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';

// Acceptance oracle frozen before product source/test-helper inspection:
// fixtures/recovery-independent-ledger-v1.json
// SHA-256 00e4efc143ee2bda402a5e50b6669baadba33ab66eac31bc2e88fb11df2e90b5
// Run against a source snapshot with MORI_INDEPENDENT_ROOT=/absolute/tree.
// These tests are synthetic API/DOM tests; provider usefulness is a separate
// explicitly pending case below. They do not claim actual Chrome or IME proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ledger, createWorkerBoundary, createDesktopBoundary } = require('./fixtures/recovery-independent-harness');

test('independent acceptance oracle remains the pre-source frozen version', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/recovery-independent-ledger-v1.json'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), '00e4efc143ee2bda402a5e50b6669baadba33ab66eac31bc2e88fb11df2e90b5');
});

for (const fault of ['throw', 'reject', 'pending']) {
  test(`I-A1 independent query ${fault}: normal alarms restore attested protocol reports without diagnostic assistance`, async () => {
    const boundary = createWorkerBoundary({ queryFault: fault });
    boundary.addProtocolPage(31, ledger.conversations.A);
    boundary.start();
    await boundary.clock.advance(2000);
    const pairingBeforeRelease = structuredClone(boundary.local.moriCredential);
    const releasedAt = boundary.clock.now;
    boundary.releaseQuery();
    await boundary.clock.advance(ledger.method.automaticRecoveryDeadlineMs);
    // This positive protocol control checks new page traffic, not retained
    // running state or a recovery success category. The stand-in attestation
    // does not establish real provider binding or count as I-B8.
    const renewed = boundary.log.deliveries.filter(({ event }) => event.tabId === 31
      && event.conversationRef === '/c/independent-alpha'
      && event.observedAt >= releasedAt && event.replay === false);
    assert.equal(boundary.log.driverActions.length, 0, 'the test driver must not assist automatic recovery');
    assert.deepEqual(boundary.local.moriCredential, pairingBeforeRelease, 'an enumeration failure must not discard pairing');
    assert.ok(!boundary.log.transport.some(item => item.action === 'disable'),
      'I-A1: a tab-enumeration failure must not disable transport as a storage failure');
    assert.ok(renewed.length > 0,
      'I-A1: a new current-document report must arrive by 45 seconds after the query fault is released');
    assert.ok(renewed.some(({ event }) => event.conversationTitle === 'Independent Alpha Conversation'),
      'the renewed report must identify the expected conversation rather than return only healthy');
    assert.ok(renewed.some(({ event }) => event.requestPreview === 'ALPHA_SUBMITTED_1'
      && event.phase === 'idle' && event.observation === 'fresh'),
    'the attested protocol control must restore its known submission and usable state; permanent unknown is insufficient');
    const snapshot = await boundary.options('mori.options.status');
    assert.notEqual(snapshot.connection.code, 'storage_failed');
  });
}

for (const delay of [1499, 1500, 1501, 1700, 5000]) {
  test(`I-A1 independent query delay ${delay} ms preserves storage health at the timeout boundary`, async () => {
    let calls = 0;
    const boundary = createWorkerBoundary({ autoReady: false, queryFault: ({ clock, pages }) => {
      const captured = [...pages.values()].map(page => structuredClone(page.tab));
      if (++calls !== 2) return Promise.resolve(captured);
      return new Promise(resolve => clock.schedule(() => resolve(captured), delay));
    } });
    boundary.addProtocolPage(31, ledger.conversations.A);
    boundary.start(); await boundary.clock.advance(2000);
    const releasedAt = boundary.clock.now;
    boundary.releaseQuery();
    await boundary.clock.advance(45000);
    assert.equal(boundary.log.driverActions.length, 0);
    assert.ok(!boundary.log.transport.some(item => item.action === 'disable'),
      'I-A1: a tab-enumeration failure must not disable transport as a storage failure');
    assert.ok(boundary.log.deliveries.some(({ event }) => event.observedAt >= releasedAt && !event.replay
      && event.tabId === 31 && event.conversationRef === '/c/independent-alpha'
      && event.conversationTitle === 'Independent Alpha Conversation' && event.requestPreview === 'ALPHA_SUBMITTED_1'),
    'I-A1: a new current-document report must arrive by 45 seconds after the query fault is released');
  });
}

test('I-A3 independent stale enumeration cannot close a later accepted physical tab', async () => {
  const boundary = createWorkerBoundary({ autoReady: false });
  const first = boundary.addProtocolPage(31, ledger.conversations.A);
  boundary.start(); await boundary.clock.advance(1000);
  let resolveOldList;
  let started = false;
  boundary.setQueryFault(() => {
    started = true;
    return new Promise(resolve => { resolveOldList = resolve; });
  });
  boundary.chrome.runtime.onStartup.fire();
  await boundary.clock.drain();
  assert.equal(started, true, 'the old enumeration must actually be pending before introducing the new tab');
  const later = boundary.addProtocolPage(47, ledger.conversations.C);
  const accepted = await later.publish();
  assert.equal(accepted.ok, true, 'the second physical tab must be durably accepted before the stale result returns');
  const cut = boundary.log.deliveries.length;
  boundary.releaseQuery(); resolveOldList([structuredClone(first.tab)]);
  await boundary.clock.advance(2000);
  assert.ok(!boundary.log.deliveries.slice(cut).some(({ event }) => event.tabId === 47 && event.kind === 'closed'),
    'I-A3: an old enumeration must not emit a close event for a tab introduced after it began');
  assert.ok(Object.values(boundary.session.moriSessions.sessions).some(record => record.tabId === 47 && !record.closed),
    'the later physical tab must remain a current row');
});

for (const failure of ['local.access', 'session.access', 'local.get', 'session.get', 'local.set', 'session.set']) {
  test(`I-A2 independent actual ${failure} failure remains fatal before observation ACK`, async () => {
    const seedLocal = failure === 'local.set' ? { moriClientId: undefined, moriCredential: null } : {};
    const boundary = createWorkerBoundary({ storageFault: failure, seedLocal });
    const page = boundary.addPage(31, ledger.conversations.A);
    boundary.start();
    await boundary.clock.drain();
    const status = await boundary.options('mori.options.status');
    assert.equal(status.ok, false, 'a real mandatory storage failure must not be masked as successful initialization');
    assert.equal(status.connection.state, 'error');
    assert.equal(status.connection.code, 'storage_failed');
    const acknowledgement = await page.context.chrome.runtime.sendMessage({ type: 'mori.observation', v: 1,
      pageInstanceId: 'independent-uncommitted-page', contentSequence: 1, observedAt: boundary.clock.now,
      status: 'running', generationToken: 'independent-uncommitted-turn', outcome: null,
      conversationTitle: 'Independent Alpha Conversation', requestPreview: 'ALPHA_SUBMITTED_1' });
    assert.equal(acknowledgement.ok, false, 'I-A2: no observation success ACK may escape failed durable initialization');
    assert.equal(boundary.log.deliveries.length, 0);
    assert.ok(!boundary.log.transport.some(item => item.action === 'enable'));
  });
}

for (const failure of ['local.set', 'session.set']) {
  test(`I-A2 independent terminal ${failure} failure withholds ACK and preserves any written journal`, async () => {
    const boundary = createWorkerBoundary();
    const page = boundary.addProtocolPage(31, ledger.conversations.A);
    boundary.start(); await boundary.clock.advance(1000);
    page.protocol = { status: 'running', generationToken: 'independent-real-start', outcome: null };
    assert.equal((await page.publish()).ok, true);
    boundary.setStorageFault(failure);
    page.protocol = { status: 'settled', generationToken: 'independent-real-start', outcome: 'unverified' };
    const acknowledgement = await page.publish();
    assert.equal(acknowledgement.ok, false, 'I-A2: an undurable terminal observation must not receive success ACK');
    assert.equal(boundary.log.deliveries.filter(({ event }) => event.kind === 'terminal').length, 0);
    const status = await boundary.options('mori.options.status');
    assert.equal(status.ok, false); assert.equal(status.connection.code, 'storage_failed');
    if (failure === 'session.set') {
      assert.equal(boundary.local.moriOutbox.events.length, 1, 'the terminal journal written before the failed session write must survive');
      assert.equal(boundary.local.moriOutbox.events[0].kind, 'terminal');
    }
  });
}

test('I-B1 independent cold injection with route B / central A never attributes A to B', async () => {
  const boundary = createWorkerBoundary();
  const page = boundary.addPage(31, ledger.conversations.A, { generating: true });
  // This is a fresh isolated-world injection: there is no old observer, route
  // history or successful prior metadata sample available to the product.
  page.setRoute(ledger.conversations.B);
  page.replaceNavigation(ledger.conversations.B);
  boundary.start();
  await boundary.clock.advance(100);
  await boundary.clock.advance(1900);
  await boundary.clock.advance(8000);
  // New nodes with the old text and controls defeat identity-only fencing.
  page.replaceCentral(ledger.conversations.A, true); page.mutate();
  // Include a normal 30-second retry after the initial recovery ticket expires.
  // A time-only approval must not escape merely by waiting for the next ticket.
  await boundary.clock.advance(35000);
  const beforeIdle = structuredClone(boundary.log.deliveries);
  page.replaceCentral(ledger.conversations.B, false); page.mutate();
  await boundary.clock.advance(2000);
  const records = boundary.log.deliveries.map(item => item.event);
  assert.ok(boundary.log.injections.length > 0, 'the adversarial document must actually have received the product content script');
  assert.ok(!records.some(event => event.conversationRef === '/c/independent-beta' && event.requestPreview === 'ALPHA_SUBMITTED_1'),
    'I-B1: route B must never acquire the submitted text belonging to central conversation A');
  assert.ok(!beforeIdle.some(({ event }) => event.conversationRef === '/c/independent-beta' && event.phase === 'running'),
    'I-B1: suppressing the excerpt alone is insufficient; A generation must not become B generation');
  assert.equal(records.filter(event => event.conversationRef === '/c/independent-beta' && event.kind === 'terminal').length, 0,
    'I-B1: showing an existing idle B after a broken observation period must not manufacture a B receipt');
  const persisted = JSON.stringify(boundary.log.writes);
  assert.ok(!persisted.includes('ALPHA_SUBMITTED_1'), 'unbound central text must not reach extension persistence');
  assert.ok(!persisted.includes('ALPHA_PRIVATE_DRAFT') && !persisted.includes('BETA_PRIVATE_DRAFT'));
  assert.ok(!persisted.includes('ASSISTANT_NOT_ALLOWED'));
  assert.equal(page.composer.value, 'ALPHA_PRIVATE_DRAFT', 'recovery must not modify the existing composer draft');
});

test('I-B2 independent current page identity cannot turn unbound route B / central A into focus success', async () => {
  const boundary = createWorkerBoundary();
  const page = boundary.addPage(31, ledger.conversations.A, { generating: true });
  page.setRoute(ledger.conversations.B); page.replaceNavigation(ledger.conversations.B);
  boundary.start(); await boundary.clock.advance(2000);
  const identity = boundary.log.inbound.map(entry => entry.message).findLast(message => typeof message.pageInstanceId === 'string');
  assert.ok(identity, 'the test must use the identity of the actual current observer, not a deliberately stale ID');
  const response = await page.messages.request({ type: 'mori.focus.check', pageInstanceId: identity.pageInstanceId,
    conversationRef: '/c/independent-beta' }, { id: boundary.chrome.runtime.id });
  assert.equal(response.ok, false, 'I-B2: current document/route identity alone cannot authorize focus-and-ACK');
});

test('I-B2 independent worker rejects focus after its current granted observer loses conversation binding', async () => {
  const boundary = createWorkerBoundary();
  const page = boundary.addProtocolPage(31, ledger.conversations.B);
  boundary.start(); await boundary.clock.advance(1000);
  const accepted = boundary.log.deliveries.map(item => item.event).findLast(event => event.tabId === 31 && !event.replay);
  assert.ok(accepted, 'the protocol control must first establish a real accepted row and a current grant');
  const focusRequest = { v: 1, requestId: 'independent-focus-1', noticeSequence: null,
    browserRunId: accepted.browserRunId, sessionId: accepted.sessionId, tabId: 31,
    pageInstanceId: accepted.pageInstanceId, routeRevision: accepted.routeRevision,
    conversationRef: '/c/independent-beta' };
  assert.equal((await boundary.transport().options.onFocus(focusRequest)).ok, true,
    'the same current identity must be focusable before the independent binding loss');
  page.bindingState = 'unconfirmed';
  const result = await boundary.transport().options.onFocus({ ...focusRequest, requestId: 'independent-focus-2' });
  assert.equal(result.ok, false,
    'I-B2: the worker must reject the current granted observer after binding is lost, even if identity-only focus says yes');
});

test('I-B2 independent health, observe, visibility and pageshow cannot admit unbound central A', async () => {
  const boundary = createWorkerBoundary();
  const page = boundary.addPage(31, ledger.conversations.A, { generating: true });
  page.setRoute(ledger.conversations.B); page.replaceNavigation(ledger.conversations.B);
  boundary.start(); await boundary.clock.advance(2000);
  // This is deliberately outside the automatic-recovery verdict. Here these
  // messages are hostile alternate entry points, not waiting helpers.
  await page.messages.request({ type: 'mori.observe.now' }, { id: boundary.chrome.runtime.id });
  await page.messages.request({ type: 'mori.health.check' }, { id: boundary.chrome.runtime.id });
  page.doc.dispatch('visibilitychange'); page.fire('pageshow');
  await boundary.clock.advance(12000);
  assert.ok(!boundary.log.deliveries.some(({ event }) => event.conversationRef === '/c/independent-beta'
    && (event.requestPreview === 'ALPHA_SUBMITTED_1' || event.phase === 'running' || event.kind === 'terminal')),
  'I-B2: no alternate observation entry point may bypass the conversation gate');
});

test('I-B3 independent pause/resume cannot revive an old observation without a new worker grant', async () => {
  const boundary = createWorkerBoundary({ autoReady: false });
  const page = boundary.addProtocolPage(31, ledger.conversations.A);
  boundary.start(); await boundary.clock.advance(1000);
  const last = boundary.log.inbound.map(item => item.message).findLast(message => message.type === 'mori.observation');
  assert.ok(last, 'a formerly accepted observer must exist before revoking it');
  assert.equal((await boundary.options('mori.options.enabled', { enabled: false })).ok, true);
  // Resume is permitted but the new automatic enumeration finds no eligible
  // tab in this trial, so it cannot supply a fresh grant to the old observer.
  boundary.setQueryFault(() => Promise.resolve([]));
  assert.equal((await boundary.options('mori.options.enabled', { enabled: true })).ok, true);
  const cut = boundary.log.deliveries.length;
  const response = await page.context.chrome.runtime.sendMessage({ ...last,
    contentSequence: last.contentSequence + 1, observedAt: boundary.clock.now,
    status: 'running', generationToken: 'independent-expired-observer-turn', outcome: null });
  await boundary.clock.drain();
  assert.equal(response.ok, false, 'I-B3: an old observation must not regain authority merely because monitoring resumes');
  assert.ok(!boundary.log.deliveries.slice(cut).some(({ event }) => event.phase === 'running'));
});

// External event inputs encode the frozen R1/R2 ledger directly. This function
// does not consult the reducer, store, metadata reader or any fixture helper.
function externalEvent({ sequence, turn, kind = 'observation', phase = 'running' }) {
  return { type: 'event', v: 1, eventId: kind === 'terminal' ? `independent-R${turn}` : `independent-start-${turn}`,
    browserRunId: 'independent-first-run', sessionId: 'independent-left-session', sequence, kind,
    provider: 'chatgpt', tabId: 31, pageInstanceId: 'independent-current-page', routeRevision: 0,
    conversationRef: '/c/independent-alpha', turnId: `independent-turn-${turn}`, generation: turn,
    phase, outcome: kind === 'terminal' ? 'unverified' : null, observation: 'fresh',
    observedAt: 1800000000000 + sequence, replay: false,
    conversationTitle: 'Independent Alpha Conversation', requestPreview: 'ALPHA_SUBMITTED_1' };
}

function unreadExternalReceipts(boundary) {
  const saved = boundary.disk();
  return saved.receipts.filter(receipt => {
    const row = saved.sessions.find(item => item.id === receipt.id);
    return receipt.noticeSequence > row.acknowledgedThrough;
  }).map(receipt => receipt.eventId).sort();
}

test('I-U12 independent persisted receipt set survives a new generation and duplicate delivery', t => {
  const desktop = createDesktopBoundary(); t.after(() => desktop.close());
  assert.equal(desktop.received.at(-1).type, 'ready', 'the real authentication owner must complete before these events');
  desktop.socket.input(externalEvent({ sequence: 1, turn: 1 }));
  desktop.socket.input(externalEvent({ sequence: 2, turn: 1, kind: 'terminal', phase: 'settled' }));
  assert.deepEqual(unreadExternalReceipts(desktop), ['independent-R1']);
  desktop.socket.input(externalEvent({ sequence: 3, turn: 2 }));
  assert.deepEqual(unreadExternalReceipts(desktop), ['independent-R1'], 'a new generation must retain the actual older receipt');
  const second = externalEvent({ sequence: 4, turn: 2, kind: 'terminal', phase: 'settled' });
  desktop.socket.input(second);
  assert.deepEqual(unreadExternalReceipts(desktop), ['independent-R1', 'independent-R2']);
  desktop.socket.input({ ...second, replay: true });
  assert.deepEqual(unreadExternalReceipts(desktop), ['independent-R1', 'independent-R2'], 'replay must not add a third receipt');
  assert.equal(desktop.bridge.getSnapshot()[0].unreadCount, 2);
});

for (const focusOk of [true, false]) {
  test(`I-U13 independent ${focusOk ? 'successful' : 'failed'} focus preserves the exact later R2 receipt`, async t => {
    const desktop = createDesktopBoundary(); t.after(() => desktop.close());
    desktop.socket.input(externalEvent({ sequence: 1, turn: 1 }));
    desktop.socket.input(externalEvent({ sequence: 2, turn: 1, kind: 'terminal', phase: 'settled' }));
    const row = desktop.bridge.getSnapshot()[0];
    const focusing = desktop.bridge.focus(row.id);
    const request = desktop.received.at(-1);
    assert.equal(request.type, 'focus.request');
    assert.equal(request.tabId, 31); assert.equal(request.conversationRef, '/c/independent-alpha');
    desktop.socket.input(externalEvent({ sequence: 3, turn: 2 }));
    desktop.socket.input(externalEvent({ sequence: 4, turn: 2, kind: 'terminal', phase: 'settled' }));
    desktop.socket.input({ type: 'focus.result', requestId: request.requestId, ok: focusOk,
      browserRunId: request.browserRunId, sessionId: request.sessionId, pageInstanceId: request.pageInstanceId,
      routeRevision: request.routeRevision, conversationRef: request.conversationRef });
    assert.equal((await focusing).ok, focusOk);
    assert.deepEqual(unreadExternalReceipts(desktop), focusOk ? ['independent-R2'] : ['independent-R1', 'independent-R2'],
      'I-U13: focus must acknowledge its captured receipt only, never all receipts present at completion');
  });
}

test.todo('I-B8 UNKNOWN: useful automatic recovery in real ChatGPT/Claude requires independently verified provider binding; synthetic quarantine is insufficient');
