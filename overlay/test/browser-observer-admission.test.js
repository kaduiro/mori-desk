const CURRENT_VERSION = require('../extensions/browser-bridge/manifest.json').version;
/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const utils = require('../extensions/browser-bridge/provider-utils');
const binding = require('../extensions/browser-bridge/conversation-binding');

const register = { type: 'mori.observer.register', v: 1, pageInstanceId: 'page-a', observerVersion: CURRENT_VERSION, attemptId: null };
const lease = { workerEpoch: 'worker-a', leaseId: 'lease-a', bindingEpoch: 'binding-a' };
const identity = { ok: true, v: 1, observerVersion: CURRENT_VERSION, pageInstanceId: 'page-a',
  route: { provider: 'chatgpt', path: '/c/a', conversationRef: '/c/a' },
  binding: { state: 'confirmed', epoch: 'binding-a' }, lease };
const observation = { type: 'mori.observation', v: 1, pageInstanceId: 'page-a',
  contentSequence: 1, observedAt: 1000, status: 'idle', generationToken: null, outcome: null };

test('registration schema requires the version, an explicit ticket origin, and no extra fields', () => {
  assert.ok(utils.safeObserverRegister(register));
  assert.ok(utils.safeObserverRegister({ ...register, attemptId: 'recovery-123' }));
  for (const input of [{ ...register, attemptId: undefined }, { ...register, attemptId: '' },
    { ...register, observerVersion: '0.1.6' }, { ...register, pageInstanceId: 123 },
    { ...register, private: 'PRIVATE' }, { ...register, v: 2 }]) assert.equal(utils.safeObserverRegister(input), null);
});

test('bootstrap schema cannot turn an unconfirmed binding, inconsistent route or epoch into an admitted identity', () => {
  assert.deepEqual(utils.safeObserverIdentity(identity), identity);
  assert.ok(utils.safeObserverIdentity({ ...identity, binding: { state: 'unconfirmed', epoch: 'binding-a' }, lease: null }));
  for (const input of [{ ...identity, binding: { state: 'unconfirmed', epoch: 'binding-a' } },
    { ...identity, binding: { state: 'confirmed', epoch: 'different' } },
    { ...identity, route: { ...identity.route, conversationRef: '/c/b' } },
    { ...identity, observerVersion: '0.1.6' }, { ...identity, lease: undefined },
    { ...identity, route: { ...identity.route, path: '//unrelated.invalid/c/a' } }]) {
    assert.equal(utils.safeObserverIdentity(input), null);
  }
  assert.deepEqual(utils.safeObserverIdentity({ ...identity, private: 'PRIVATE',
    lease: { ...lease, private: 'PRIVATE' }, route: { ...identity.route, private: 'PRIVATE' } }), identity);
});

test('observation projects all three lease fields together and never forwards arbitrary fields', () => {
  assert.ok(utils.safeObservation(observation), 'legacy reducer-only schema can remain readable; worker enforces admission');
  const projected = utils.safeObservation({ ...observation, ...lease, private: 'PRIVATE' });
  for (const field of Object.keys(lease)) {
    assert.equal(projected[field], lease[field]);
    assert.equal(utils.safeObservation({ ...observation, [field]: lease[field] }), null);
    assert.equal(utils.safeObservation({ ...observation, ...lease, [field]: {} }), null);
  }
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
});

test('production verifier never treats URL, fake DOM attributes, or elapsed samples as conversation proof', () => {
  let ids = 0;
  const tracker = binding.createTracker({ uuid: () => `binding-${++ids}` });
  const doc = new Proxy({}, { get() { throw new Error('No unreviewed DOM source may be read'); } });
  const a = tracker.sample(doc, 'https://chatgpt.com/c/a');
  for (let i = 0; i < 100; i++) assert.deepEqual(tracker.sample(doc, 'https://chatgpt.com/c/a'), a);
  const b = tracker.sample(doc, 'https://chatgpt.com/c/b');
  assert.notEqual(b.epoch, a.epoch);
  assert.equal(b.state, 'unconfirmed');
  assert.equal(tracker.sample(doc, 'https://claude.ai/chat/c').state, 'unconfirmed');
  assert.equal(tracker.sample(doc, 'https://unrelated.invalid/').state, 'unconfirmed');
});
