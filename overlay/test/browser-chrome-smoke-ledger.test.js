/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPassiveLedger } = require('./browser-extension-chrome-smoke');

const history = { id: 'receipt-row', browserRunId: 'baseline-run', isCurrent: true,
  lastObservationAt: 1000, phase: 'running', observation: 'fresh', unreadCount: 1,
  pendingNotice: { noticeSequence: 1, turnId: 'captured-R1', outcome: 'unverified' } };
function recorder() {
  let clock = 1000;
  const ledger = createPassiveLedger({ baselineRows: [history], startedAt: 1000, now: () => clock });
  return { at(elapsed, rows) { clock = 1000 + elapsed; ledger.capture(rows); }, snapshot: ledger.snapshot };
}
const report = overrides => ({ id: 'candidate-row', browserRunId: 'candidate-run', isCurrent: true,
  lastObservationAt: 1100, phase: 'running', observation: 'fresh', unreadCount: 0, ...overrides });

test('passive smoke never mistakes an old fresh row for a new candidate observation', () => {
  const f = recorder();
  f.at(10, [history]);
  f.at(100, [{ ...history, lastObservationAt: 1200 }]);
  assert.deepEqual(f.snapshot(), { firstAcceptedObservationMs: null, firstUsefulObservationMs: null,
    receiptSetChangedAtMs: null, verdict: 'FAIL-no-recovery' });
});

test('passive smoke latches transient idle acceptance even when a later diagnostic would see no row', () => {
  const f = recorder();
  f.at(5, [history, report({ phase: 'idle', conversationTitle: 'unverified fixture metadata' })]);
  f.at(6, [history]);
  assert.equal(f.snapshot().firstAcceptedObservationMs, 5);
  assert.equal(f.snapshot().firstUsefulObservationMs, null);
  assert.equal(f.snapshot().verdict, 'FAIL-no-recovery');
});

test('passive smoke latches unsupported metadata even without a fresh observation timestamp', () => {
  const f = recorder();
  f.at(9, [history, report({ phase: 'idle', observation: 'unsupported', lastObservationAt: 0,
    conversationTitle: 'unverified fixture metadata' })]);
  f.at(10, [history]);
  assert.equal(f.snapshot().firstAcceptedObservationMs, 9);
  assert.equal(f.snapshot().firstUsefulObservationMs, null);
  assert.equal(f.snapshot().verdict, 'FAIL-no-recovery');
});

test('passive smoke records deadline arrival at the callback and does not upgrade a late result', () => {
  const onTime = recorder(); onTime.at(45000, [history, report()]);
  assert.equal(onTime.snapshot().verdict, 'PASS');
  const late = recorder(); late.at(45001, [history, report()]);
  late.at(120001, [history, report()]);
  assert.equal(late.snapshot().firstUsefulObservationMs, 45001);
  assert.equal(late.snapshot().verdict, 'FAIL-late');
});

test('passive smoke detects receipt replacement despite an unchanged count and a later restoration', () => {
  const f = recorder();
  f.at(10, [{ ...history, pendingNotice: { ...history.pendingNotice, turnId: 'wrong-R2' } }]);
  f.at(11, [history]);
  assert.equal(f.snapshot().receiptSetChangedAtMs, 10);
});
