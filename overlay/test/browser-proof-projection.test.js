/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Synthetic ordering/clock tests, not installed Chrome or native UI evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createObservationProofs } = require('../src/browser-observation-proofs');
const contract = require('../extensions/browser-bridge/monitoring-contract');

function fixture() {
  let wall = 1000, mono = 0, serial = 0;
  const proofs = createObservationProofs({ now: () => wall, monotonic: () => mono, uuid: () => `p-${++serial}` });
  const connection = { clientId: 'client-a' };
  const event = { tabId: 1, browserRunId: 'run-a', sessionId: 'session-a', provider: 'chatgpt',
    pageInstanceId: 'page-a', routeRevision: 0, eventId: 'event-a', sequence: 1,
    kind: 'observation', observation: 'fresh', observedAt: wall, replay: false,
    scope: { kind: 'conversation', viewEpoch: 'view-a', bindingEpoch: 'binding-a', samplingEpoch: 'sampling-a',
      workerEpoch: 'worker-a', leaseId: 'lease-a', documentId: 'document-a', startUnobserved: false } };
  const health = token => ({ proofs: token ? [token] : [], revokedProofs: [], browserRunId: 'run-a', workerEpoch: 'worker-a',
    providers: ['chatgpt', 'claude'].map(provider => ({ provider, inventory: 'known',
      fresh: provider === 'chatgpt' && token ? 1 : 0, unmonitored: provider === 'chatgpt' && !token ? 1 : 0,
      reasons: Object.fromEntries(contract.REASONS.map(reason => [reason, reason === 'delivery_pending' && provider === 'chatgpt' && !token ? 1 : 0])) })) });
  function admit(e = event) { return proofs.observe(connection, e, 'committed_current').proof; }
  function verified(token) { const h = health(token); assert.equal(proofs.verifyHealth(connection, h), true); return h; }
  function row(h) {
    const projected = proofs.projectHealth(connection, h);
    assert.equal(Object.hasOwn(projected, 'proofs'), false);
    for (const r of projected.providers) assert.equal(r.unmonitored, Object.values(r.reasons).reduce((a,b) => a+b, 0));
    return projected.providers[0];
  }
  return { proofs, connection, event, health, admit, verified, row,
    time(w, m = w - 1000) { wall = w; mono = m; } };
}

test('a newer commit needs its exact health proof and does not time-expire the earlier health snapshot', () => {
  const f = fixture(), first = f.admit(), oldHealth = f.verified(first);
  f.time(2000);
  const next = f.admit({ ...f.event, eventId: 'event-b', sequence: 2, observedAt: 2000 });
  const waiting = f.row(oldHealth);
  assert.equal(waiting.fresh, 0); assert.equal(waiting.reasons.delivery_pending, 1);
  assert.equal(waiting.reasons.observation_expired, 0);
  assert.equal(f.proofs.verifyHealth(f.connection, f.health(first)), false);
  assert.equal(f.row(f.verified(next)).fresh, 1);
});

test('the original sampling deadline remains inclusive at 15 seconds and expires beyond it', () => {
  const f = fixture(), h = f.verified(f.admit());
  f.time(16000); assert.equal(f.row(h).fresh, 1);
  f.time(16001); const expired = f.row(h);
  assert.equal(expired.fresh, 0); assert.equal(expired.reasons.observation_expired, 1);
  assert.equal(expired.reasons.delivery_pending, 0);
});

test('a newer unreported commit does not refresh any old token even after repeated replacements', () => {
  const f = fixture(), first = f.admit(), h = f.verified(first);
  for (let sequence = 2; sequence <= 40; sequence++) {
    const at = sequence * 1000; f.time(at);
    f.admit({ ...f.event, sequence, eventId: `event-${sequence}`, observedAt: at });
    assert.equal(f.proofs.verifyHealth(f.connection, f.health(first)), false);
    const projected = f.row(h);
    assert.equal(projected.fresh, 0); assert.equal(projected.reasons.delivery_pending, 1);
  }
  f.time(55001);
  assert.equal(f.row(h).reasons.observation_expired, 1);
});

test('document, scope, session and page replacements cannot borrow an earlier health grant', () => {
  const replacements = [
    { sessionId: 'session-b' }, { pageInstanceId: 'page-b' }, { routeRevision: 1 },
    ...['documentId', 'samplingEpoch', 'leaseId', 'viewEpoch', 'bindingEpoch'].map(field => ({ scope: { [field]: `${field}-b` } })),
  ];
  for (const replacement of replacements) {
    const f = fixture(), h = f.verified(f.admit()); f.time(2000);
    f.admit({ ...f.event, ...replacement, scope: { ...f.event.scope, ...replacement.scope },
      eventId: 'event-b', sequence: 2, observedAt: 2000 });
    const projected = f.row(h);
    assert.equal(projected.fresh, 0); assert.equal(projected.reasons.observation_pending, 1);
    assert.equal(projected.reasons.delivery_pending, 0);
  }
});

test('gap, closure, uncertainty and explicit revocation remove freshness immediately', () => {
  for (const transition of [{kind:'gap'}, {kind:'closed'}, {observation:'stale'}]) {
    const f = fixture(), h = f.verified(f.admit());
    f.admit({ ...f.event, ...transition, sequence: 2 });
    assert.equal(f.row(h).fresh, 0);
    assert.equal(f.row(h).reasons.observation_pending, 1);
  }
  const f = fixture(), token = f.admit(), h = f.verified(token);
  const revoked = f.health(null); revoked.revokedProofs = [token];
  assert.equal(f.proofs.verifyHealth(f.connection, revoked), true);
  assert.equal(f.row(h).fresh, 0);
});

test('connection retirement and replacement never transfer a health grant', () => {
  const f = fixture(), token = f.admit(), h = f.verified(token);
  f.proofs.revokeConnection(f.connection);
  const other = { clientId: f.connection.clientId };
  f.proofs.observe(other, { ...f.event, sequence: 2, eventId: 'event-b' }, 'committed_current');
  assert.equal(f.row(h).fresh, 0);
  assert.equal(f.proofs.verifyHealth(other, f.health(token)), false);
});

test('wall clock reversal, future observations and monotonic expiry cannot retain freshness', () => {
  for (const [wall, mono] of [[999, 1], [1000, 15001], [1000, -1]]) {
    const f = fixture(), h = f.verified(f.admit()); f.time(wall, mono);
    assert.equal(f.row(h).fresh, 0);
  }
  const f = fixture(); assert.equal(f.admit({ ...f.event, observedAt: 1001 }), null);
});

test('replacement history adds neither physical admission slots nor proof authority', () => {
  const f = fixture(), token = f.admit(), h = f.verified(token);
  for (let sequence = 2; sequence <= 40; sequence++) f.admit({ ...f.event, sequence, eventId: `e-${sequence}` });
  for (let tabId = 2; tabId <= 20; tabId++) assert.ok(f.admit({ ...f.event, tabId, sessionId: `s-${tabId}` }));
  const blocked = f.proofs.observe(f.connection, { ...f.event, tabId: 21, sessionId: 's-21' }, 'committed_current');
  assert.equal(blocked.proof, null); assert.equal(blocked.reason, 'desktop_capacity');
  assert.equal(f.row(h).fresh, 0);
  assert.equal(f.proofs.verifyHealth(f.connection, f.health(token)), false);
});
