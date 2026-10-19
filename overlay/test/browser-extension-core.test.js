const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const utils = require('../extensions/browser-bridge/provider-utils');
const coordinator = require('../extensions/browser-bridge/session-coordinator');
const observation = require('../extensions/browser-bridge/observation-controller');
const outbox = require('../extensions/browser-bridge/outbox');
const transport = require('../extensions/browser-bridge/transport');
const protocol = require('../src/browser-bridge-protocol');
const manifest = require('../extensions/browser-bridge/manifest.json');

const now = 1780000000000;
function fixture() {
  let counter = 0;
  let state = coordinator.newState('browser-run');
  const uuid = () => `uuid-${++counter}`;
  return {
    get state() { return state; },
    ingest(patch = {}, context = {}) {
      const next = coordinator.reduceObservation(state, {
        type: 'mori.observation', v: 1, pageInstanceId: 'page-1', contentSequence: ++counter,
        observedAt: now, status: 'running', generationToken: 'generation-1', outcome: null, ...patch,
      }, { tabId: 7, documentId: 'document-1', route: utils.routeForUrl('https://chatgpt.com/c/conversation-1'), ...context }, { uuid, now });
      state = next.state;
      next.events.forEach(event => assert.deepEqual(protocol.validateEvent(event), event));
      return next;
    },
    close(tabId = 7) {
      const next = coordinator.closeTab(state, tabId, { uuid, now }); state = next.state; return next;
    },
    snapshot() {
      const next = coordinator.snapshot(state, { uuid }); state = next.state; return next;
    },
  };
}

test('fixed public key matches the desktop allowlist, and browser capabilities are narrow', () => {
  const id = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
  assert.equal(id, protocol.EXTENSION_ID);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*', 'https://claude.ai/*']);
  assert.equal(manifest.minimum_chrome_version, '120');
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.update_url, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  assert.ok(!manifest.key.includes('PRIVATE KEY'));
});

test('URL normalization rejects unrelated origins and strips query, fragment, and content', () => {
  assert.deepEqual(utils.routeForUrl('https://chatgpt.com/c/abc-123?secret=hidden#text'),
    { provider: 'chatgpt', path: '/c/abc-123', conversationRef: '/c/abc-123' });
  assert.deepEqual(utils.routeForUrl('https://claude.ai/new'), { provider: 'claude', path: '/new', conversationRef: null });
  for (const url of ['https://evil.test/c/abc', 'https://chatgpt.com.evil.test/c/abc', 'http://chatgpt.com/c/abc',
    'https://user:pass@chatgpt.com/c/abc', 'https://chatgpt.com:8443/c/abc',
    'https://chatgpt.com/g/g-custom/edit', 'https://chatgpt.com/g/g-custom/c/a/b',
    'https://chatgpt.com/g/g-custom%2Fother/c/abc', 'https://chatgpt.com/g/g-custom/c/a%2Fb',
    'https://chatgpt.com/g/not-a-gpt/c/abc', 'https://claude.ai/project/private', 'https://chatgpt.com/c/a/b']) {
    assert.equal(utils.routeForUrl(url), null, url);
  }
  const sanitized = utils.safeObservation({ type: 'mori.observation', v: 1, pageInstanceId: 'doc',
    contentSequence: 1, observedAt: now, status: 'idle', generationToken: null, outcome: null,
    prompt: 'PRIVATE', answer: 'PRIVATE', title: 'PRIVATE', secret: 'PRIVATE' });
  assert.ok(sanitized);
  assert.ok(!JSON.stringify(sanitized).includes('PRIVATE'));
  assert.equal(utils.safeObservation({ ...sanitized, type: 'mori.observation', v: 1, outcome: 'completed' }), null);
});

test('scoped ChatGPT conversations keep only the canonical conversation ID in session storage and events', () => {
  const url = 'https://chatgpt.com/g/g-p-0123-PRIVATE_PROJECT_NAME/c/conversation-1?secret=PRIVATE_QUERY#PRIVATE_FRAGMENT';
  const route = utils.routeForUrl(url);
  assert.deepEqual(route, { provider: 'chatgpt', path: '/c/conversation-1', conversationRef: '/c/conversation-1' });
  assert.equal(utils.sameRoute(route, utils.routeForUrl('https://chatgpt.com/c/conversation-1')), true);
  const f = fixture();
  const started = f.ingest({}, { route });
  assert.equal(started.events.length, 1);
  assert.equal(started.events[0].phase, 'running');
  assert.equal(started.events[0].conversationRef, '/c/conversation-1');
  assert.doesNotMatch(JSON.stringify({ state: f.state, events: started.events }), /PRIVATE_|\/g\//);
  for (const url of ['https://chatgpt.com.evil.test/g/g-custom/c/id',
    'http://chatgpt.com/g/g-custom/c/id', 'https://chatgpt.com:8443/g/g-custom/c/id',
    'https://user:pass@chatgpt.com/g/g-custom/c/id', `https://chatgpt.com/g/g-${'a'.repeat(161)}/c/id`]) {
    assert.equal(utils.routeForUrl(url), null, url);
  }
});

test('switching empty GPT/project scopes fences the old row without a completion or stored scope name', () => {
  const f = fixture();
  const a = f.ingest({}, { route: utils.routeForUrl('https://chatgpt.com/g/g-PRIVATE_SCOPE_A') }).events[0];
  const changed = f.ingest({ pageInstanceId: 'scope-b', generationToken: 'generation-b' },
    { route: utils.routeForUrl('https://chatgpt.com/g/g-PRIVATE_SCOPE_B') });
  assert.deepEqual(changed.events.map(event => event.kind), ['closed', 'observation']);
  assert.equal(changed.events[0].outcome, null);
  const b = changed.events[1];
  assert.notEqual(b.sessionId, a.sessionId);
  assert.equal(b.phase, 'running');
  assert.equal(coordinator.focusMatches(f.state, { requestId: 'old-focus', browserRunId: a.browserRunId,
    sessionId: a.sessionId, tabId: a.tabId, pageInstanceId: a.pageInstanceId,
    routeRevision: a.routeRevision, conversationRef: null, noticeSequence: null }), false);
  const assigned = f.ingest({ pageInstanceId: 'scope-b', generationToken: 'generation-b' },
    { route: utils.routeForUrl('https://chatgpt.com/g/g-PRIVATE_SCOPE_B/c/conversation-b') }).events[0];
  assert.equal(assigned.sessionId, b.sessionId);
  assert.equal(assigned.turnId, b.turnId);
  assert.equal(assigned.conversationRef, '/c/conversation-b');
  assert.doesNotMatch(JSON.stringify({ state: f.state, events: [...changed.events, assigned] }), /PRIVATE_SCOPE|\/g\//);
});

test('cross-scope navigation to an existing conversation cannot inherit an unfinished null-ID turn', () => {
  const a = utils.routeForUrl('https://chatgpt.com/g/g-PRIVATE_SCOPE_A');
  assert.equal(utils.canAssignConversation(a, 'https://chatgpt.com/g/g-PRIVATE_SCOPE_A/c/new-id'), true);
  assert.equal(utils.canAssignConversation(a, 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B/c/old-id'), false);
  assert.equal(utils.canAssignConversation(a, 'https://chatgpt.com/c/old-id'), false);
  const root = utils.routeForUrl('https://chatgpt.com/');
  assert.equal(utils.canAssignConversation(root, 'https://chatgpt.com/c/new-id'), true);
  assert.equal(utils.canAssignConversation(root, 'https://chatgpt.com/g/g-PRIVATE_SCOPE_B/c/old-id'), false);
  const f = fixture();
  const old = f.ingest({}, { route: a }).events[0];
  const changed = f.ingest({ pageInstanceId: 'new-scope-page', status: 'idle', generationToken: null },
    { route: utils.routeForUrl('https://chatgpt.com/g/g-PRIVATE_SCOPE_B/c/old-id') });
  assert.deepEqual(changed.events.map(event => event.kind), ['closed']);
  assert.equal(changed.events[0].outcome, null);
  assert.equal(changed.events[0].sessionId, old.sessionId);
  const target = f.state.sessions[f.state.tabs[7]];
  assert.notEqual(target.sessionId, old.sessionId);
  assert.equal(target.phase, 'idle');
  assert.equal(target.announced, false);
  assert.equal(target.turnId, null);
});

test('browser Web Crypto and Node backend use the same directional port-bound HMAC', async () => {
  const key = crypto.randomBytes(32).toString('base64url');
  const challenge = { type: 'challenge', v: 1, mode: 'pair', credentialId: 'pairing-1', clientId: 'client-1',
    productId: 'mori-desk', instanceId: 'installation-1', serverRunId: 'server-1', port: 23333,
    clientNonce: crypto.randomBytes(32).toString('base64url'), serverNonce: crypto.randomBytes(32).toString('base64url') };
  for (const label of ['server-proof', 'client-proof', 'credential', 'pair-confirm']) {
    assert.equal(transport.canonical(label, challenge), protocol.authText(label, challenge));
    assert.equal(await transport.hmac(key, transport.canonical(label, challenge), crypto.webcrypto),
      protocol.mac(key, label, challenge));
  }
  challenge.proof = protocol.mac(key, 'server-proof', challenge);
  assert.equal(transport.verifyChallenge(challenge, challenge), true);
  assert.equal(transport.verifyChallenge(challenge, { ...challenge, port: 23334 }), false);
  assert.equal(transport.verifyChallenge(challenge, { ...challenge, clientNonce: crypto.randomBytes(32).toString('base64url') }), false);
  assert.equal(transport.equalProof(challenge.proof, protocol.mac(key, 'client-proof', challenge)), false);
});

test('pairing parser accepts only a short-lived MORI code on the bounded localhost ports', () => {
  const code = { v: 1, productId: 'mori-desk', instanceId: 'instance-1', pairingId: 'pair-1', port: 23334,
    secret: crypto.randomBytes(32).toString('base64url'), expiresAt: now + 120000 };
  const encode = value => `mori1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  assert.deepEqual(transport.parsePairingCode(encode(code), now), code);
  assert.throws(() => transport.parsePairingCode(encode({ ...code, expiresAt: now }), now), /pairing_expired/);
  assert.throws(() => transport.parsePairingCode(encode({ ...code, port: 8443 }), now), /invalid_pairing_code/);
  assert.throws(() => transport.parsePairingCode(encode({ ...code, productId: 'other-product' }), now), /invalid_pairing_code/);
  assert.throws(() => transport.parsePairingCode('mori1:!!!', now), /invalid_pairing_code/);
});

test('opening a completed historical conversation produces no terminal or new turn', () => {
  const model = observation.createController({ uuid: () => 'observed-generation' });
  const idle = model.sample({ supported: true, ready: true, hasAssistant: true, generating: false }, now);
  assert.deepEqual(idle, { status: 'idle', generationToken: null, outcome: null });
  const f = fixture();
  assert.equal(f.ingest({ status: 'idle', generationToken: null }).events.length, 0);
  assert.equal(f.ingest({ status: 'settled', generationToken: 'previous', outcome: 'unverified' }).events.length, 0);
});

test('stop disappearance is only an unverified candidate, and transient or unknown DOM never completes', () => {
  const model = observation.createController({ uuid: () => 'generation-1' });
  const running = { supported: true, generating: true, ready: true, hasAssistant: true };
  assert.equal(model.sample(running, now).status, 'running');
  assert.equal(model.sample({ ...running, generating: false }, now + 100).status, 'running');
  assert.equal(model.sample(running, now + 300).status, 'running');
  assert.equal(model.sample({ supported: false }, now + 2000).status, 'unknown');
  assert.equal(model.sample({ ...running, generating: false, ready: false }, now + 10000).status, 'unknown');
  model.sample({ ...running, generating: false }, now + 10100);
  assert.deepEqual(model.sample({ ...running, generating: false }, now + 11000),
    { status: 'settled', generationToken: 'generation-1', outcome: 'unverified' });
});

test('an observed trusted stop action stays distinct from an error or an uncertain end', () => {
  const model = observation.createController({ uuid: () => 'generation-1' });
  model.sample({ supported: true, generating: true }, now);
  model.stopRequested();
  model.sample({ supported: true, generating: false, ready: true, hasAssistant: true }, now + 10);
  assert.equal(model.sample({ supported: true, generating: false, ready: true, hasAssistant: true }, now + 1000).outcome, 'interrupted');
  model.reset(); model.sample({ supported: true, generating: true }, now + 2000);
  assert.equal(model.sample({ supported: true, generating: false, error: true }, now + 2010).outcome, 'error');
});

test('two tabs of the same conversation have independent sessions and monotonic sequence numbers', () => {
  const f = fixture();
  const a = f.ingest({ contentSequence: 1 }).events[0];
  const b = f.ingest({ contentSequence: 1, pageInstanceId: 'page-2' }, { tabId: 8, documentId: 'document-2' }).events[0];
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.conversationRef, b.conversationRef);
  assert.equal(f.ingest({ contentSequence: 1 }).events.length, 0);
  assert.equal(f.ingest({ contentSequence: 2 }).events[0].sequence, a.sequence + 1);
});

test('new conversation URL assignment retains a running session, while explicit navigation closes it without completion', () => {
  const f = fixture();
  const a = f.ingest({}, { route: utils.routeForUrl('https://chatgpt.com/') }).events[0];
  const assigned = f.ingest().events[0];
  assert.equal(a.sessionId, assigned.sessionId);
  assert.equal(assigned.routeRevision, a.routeRevision + 1);
  const next = f.ingest({ status: 'idle', generationToken: null },
    { route: utils.routeForUrl('https://chatgpt.com/c/other-conversation') });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].kind, 'closed');
  assert.equal(next.events[0].outcome, null);
  assert.notEqual(next.state.tabs[7], a.sessionId);
});

test('reload and tab closure cannot manufacture a terminal event', () => {
  const f = fixture(); f.ingest();
  const reload = f.ingest({ status: 'idle', generationToken: null, pageInstanceId: 'reloaded-page', contentSequence: 1 },
    { documentId: 'reloaded-document' });
  assert.equal(reload.events[0].kind, 'observation');
  assert.equal(reload.events[0].observation, 'unsupported');
  const closed = f.close();
  assert.equal(closed.events[0].kind, 'closed');
  assert.equal(closed.events[0].outcome, null);
});

test('offline completion remains in a bounded durable outbox when the next turn starts', () => {
  const f = fixture();
  const running = f.ingest().events[0];
  const terminal = f.ingest({ status: 'settled', outcome: 'unverified' }).events[0];
  const saved = outbox.append({ v: 1, events: [] }, [terminal]);
  assert.equal(terminal.kind, 'terminal');
  const next = f.ingest({ generationToken: 'generation-2' }).events[0];
  assert.equal(next.generation, running.generation + 1);
  assert.notEqual(next.turnId, terminal.turnId);
  assert.equal(saved.events[0].turnId, terminal.turnId);
  assert.equal(f.snapshot().events[0].replay, true);
  assert.equal(f.snapshot().events[0].observation, 'stale');
  assert.equal(outbox.acknowledge(saved, { ...terminal, sessionId: 'wrong-session' }).events.length, 1);
  assert.equal(outbox.acknowledge(saved, terminal).events.length, 0);
  assert.equal(outbox.append(saved, [terminal]).events.length, 1);
  assert.throws(() => outbox.append(saved, [{ ...terminal, answer: 'PRIVATE' }]), /invalid_outbox_event/);
});

test('outbox overflow is explicit and never discards an older receipt', () => {
  const f = fixture(); f.ingest();
  const terminal = f.ingest({ status: 'settled', outcome: 'unverified' }).events[0];
  const full = outbox.append({ v: 1, events: [] }, Array.from({ length: outbox.MAX_EVENTS }, (_, index) =>
    ({ ...terminal, eventId: `event-${index}`, sessionId: `session-${index}` })));
  assert.throws(() => outbox.append(full, [{ ...terminal, eventId: 'overflow' }]), /outbox_full/);
  assert.equal(full.events.length, outbox.MAX_EVENTS);
  assert.equal(full.events[0].eventId, 'event-0');
});

test('durable terminal journal recovers a failed session write without manufacturing a different duplicate', () => {
  const f = fixture();
  f.ingest();
  const stateBeforeFailedWrite = structuredClone(f.state);
  const terminal = f.ingest({ status: 'settled', outcome: 'unverified' }).events[0];
  const recovered = coordinator.recoverDurableEvents(stateBeforeFailedWrite, [terminal]);
  const record = recovered.sessions[terminal.sessionId];
  assert.equal(record.phase, 'settled');
  assert.equal(record.sequence, terminal.sequence);
  assert.equal(record.observation, 'stale');
  const fresh = coordinator.reduceObservation(recovered, { type: 'mori.observation', v: 1,
    pageInstanceId: 'page-1', contentSequence: 999, observedAt: now + 1000,
    status: 'settled', generationToken: 'generation-1', outcome: 'unverified' },
  { tabId: 7, documentId: 'document-1', route: utils.routeForUrl('https://chatgpt.com/c/conversation-1') },
  { uuid: () => 'fresh-observation', now: now + 1000 });
  assert.equal(fresh.events[0].kind, 'observation');
  assert.notEqual(fresh.events[0].eventId, terminal.eventId);
  assert.equal(fresh.events[0].sequence, terminal.sequence + 1);
  const next = f.ingest({ generationToken: 'generation-2' }).events[0];
  assert.equal(coordinator.recoverDurableEvents(f.state, [terminal]).sessions[next.sessionId].turnId, next.turnId);
});

test('focus accepts a running row with no notice and rejects another browser run, document, or route revision', () => {
  const f = fixture(); const event = f.ingest().events[0];
  const request = { requestId: 'focus-request', browserRunId: event.browserRunId, sessionId: event.sessionId,
    tabId: event.tabId, pageInstanceId: event.pageInstanceId, routeRevision: event.routeRevision,
    conversationRef: event.conversationRef, noticeSequence: null };
  assert.equal(coordinator.focusMatches(f.state, request), true);
  for (const patch of [{ browserRunId: 'old-run' }, { pageInstanceId: 'old-document' },
    { routeRevision: 99 }, { conversationRef: '/c/other' }, { tabId: 99 }]) {
    assert.equal(coordinator.focusMatches(f.state, { ...request, ...patch }), false);
  }
});

test('content entrypoint handles trusted stop clicks but never reads text or dispatches page input', () => {
  const base = path.join(__dirname, '../extensions/browser-bridge');
  const source = ['content-script.js', 'adapters/chatgpt.js', 'adapters/claude.js']
    .map(name => fs.readFileSync(path.join(base, name), 'utf8')).join('\n');
  assert.match(source, /event\.isTrusted/);
  assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|innerText|textContent|document\.cookie|document\.title)\b/);
  assert.doesNotMatch(source, /\b(?:dispatchEvent|KeyboardEvent|InputEvent|fetch|XMLHttpRequest)\s*\(/);
  assert.doesNotMatch(source, /storage\.(?:local|sync)/);
});
