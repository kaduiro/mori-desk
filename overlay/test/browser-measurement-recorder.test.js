/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// These are unit checks for capture plumbing and interval arithmetic. They do
// not establish provider DOM, native timing, or independent acceptance results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const measurement = require('../extensions/browser-bridge/measurement-recorder.js');

test('CommonJS exports only inert factories, constants and pure helpers', () => {
  assert.equal(typeof measurement.createRecorder, 'function');
  assert.equal(typeof measurement.calibrateExternalClock, 'function');
  assert.equal(typeof measurement.delayInterval, 'function');
  assert.equal(typeof measurement.judgeDelayInterval, 'function');
  assert.equal(Object.hasOwn(measurement, 'recorder'), false);
  assert.ok(Object.isFrozen(measurement.STAGES));
  assert.ok(Object.isFrozen(measurement.STATUSES));
  assert.ok(Object.isFrozen(measurement.REASONS));
});

test('browser UMD evaluation and default recorder never consult the clock or enable capture', () => {
  const context = vm.createContext({ calls: 0 });
  vm.runInContext('performance = { now() { calls++; return 10; } };', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extensions/browser-bridge/measurement-recorder.js'), 'utf8'), context);
  assert.equal(context.calls, 0);
  vm.runInContext('recorder = MoriMeasurementRecorder.createRecorder(); recorder.record("content_observed"); result = recorder.snapshot();', context);
  assert.equal(context.calls, 0);
  assert.equal(context.result.enabled, false);
  assert.equal(context.result.status, 'unknown');
  assert.equal(context.result.reason, 'disabled');
  assert.equal(context.result.entries.length, 0);
});

test('missing monotonic clock stops enabled capture as unknown without consulting Date.now', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extensions/browser-bridge/measurement-recorder.js'), 'utf8');
  for (const performanceValue of ['undefined', 'null', '{}']) {
    const context = vm.createContext({ wallCalls: 0 });
    vm.runInContext(`performance = ${performanceValue}; Date.now = () => { wallCalls++; return 100; };`, context);
    vm.runInContext(source, context);
    vm.runInContext('recorder = MoriMeasurementRecorder.createRecorder({ enabled: true }); accepted = recorder.record("content_observed"); result = recorder.snapshot();', context);
    assert.equal(context.wallCalls, 0);
    assert.equal(context.accepted, false);
    assert.equal(context.result.status, 'unknown');
    assert.equal(context.result.reason, 'clock_invalid');
    assert.equal(context.result.active, false);
    assert.equal(context.result.entries.length, 0);
  }
});

test('explicit disabled recorder does not invoke its injected clock or read fields', () => {
  let calls = 0;
  const recorder = measurement.createRecorder({ enabled: false, now: () => { calls++; throw new Error('PRIVATE'); } });
  const fields = Object.defineProperty({}, 'status', { get() { throw new Error('PRIVATE'); } });
  assert.equal(recorder.record('worker_received', fields), false);
  assert.doesNotThrow(() => recorder.stop());
  assert.equal(recorder.snapshot().entries.length, 0);
  assert.equal(calls, 0);
});

test('enabled but empty capture is unknown and can subsequently capture a real endpoint', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  assert.equal(recorder.snapshot().status, 'unknown');
  assert.equal(recorder.snapshot().reason, 'missing');
  assert.equal(recorder.snapshot().missing, true);
  assert.equal(recorder.record('content_observed'), true);
  assert.equal(recorder.snapshot().status, 'ok');
});

test('every declared stage records with explicit enablement and categorical data', () => {
  let clock = 50;
  const recorder = measurement.createRecorder({ enabled: true, now: () => clock++, maxEntries: 64, maxDurationMs: 1000 });
  for (const stage of measurement.STAGES) assert.equal(recorder.record(stage, {
    status: 'ok', reason: 'none', count: 0, sameDocument: true, sameScope: false,
    sameConnection: true, missing: false,
  }), true);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.counts.recorded, measurement.STAGES.length);
  assert.equal(snapshot.entries[0].at, 51);
  assert.equal(snapshot.entries[0].clockGeneration, 0);
  assert.equal(snapshot.entries[0].count, 0);
  for (const stage of measurement.STAGES) assert.equal(snapshot.stages[stage], 1);
  for (const stage of ['observer_installed', 'authenticated_ready', 'registration_requested',
    'lease_received', 'sample_valid', 'continuity_broken', 'queue_enter', 'wire_send',
    'local_observation_accepted', 'durable_commit', 'ack_sent', 'ack_validated_current',
    'health_published', 'UI_applied']) assert.ok(measurement.STAGES.includes(stage));
});

test('record rejects arbitrary stage, metadata keys, IDs, text and unsupported categorical values', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  const privateText = 'PRIVATE-title-cookie-request-url-session';
  const invalid = [
    { title: privateText }, { sessionId: privateText }, { eventId: privateText },
    { url: privateText }, { text: privateText }, { html: privateText },
    { count: 1, extra: privateText }, { status: privateText }, { reason: privateText },
    { sameDocument: privateText }, { missing: null }, { count: -1 }, { count: 1.5 },
    { count: Infinity }, { count: measurement.LIMITS.maxCount + 1 }, [], null,
  ];
  for (const fields of invalid) assert.equal(recorder.record('content_observed', fields), false);
  assert.equal(recorder.record(privateText), false);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.status, 'unknown');
  assert.equal(snapshot.entries.length, 0);
  assert.equal(snapshot.counts.rejected, invalid.length + 1);
  assert.equal(JSON.stringify(snapshot).includes(privateText), false);
});

test('accessors, inherited objects, symbols and throwing proxies do not escape record', () => {
  let getterCalls = 0;
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  const accessor = Object.defineProperty({}, 'status', { get() { getterCalls++; throw new Error('PRIVATE'); } });
  const symbol = { [Symbol('PRIVATE')]: 'PRIVATE' };
  const inherited = Object.create({ status: 'ok' });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('PRIVATE'); } });
  for (const fields of [accessor, symbol, inherited, proxy]) {
    assert.doesNotThrow(() => assert.equal(recorder.record('content_observed', fields), false));
  }
  assert.equal(getterCalls, 0);
  assert.equal(recorder.snapshot().entries.length, 0);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('PRIVATE'), false);
});

test('null-prototype categorical dictionaries are accepted without arbitrary properties', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  const fields = Object.assign(Object.create(null), { status: 'pending', reason: 'delivery_pending', count: 2 });
  assert.equal(recorder.record('wire_send', fields), true);
  assert.equal(recorder.snapshot().entries[0].count, 2);
});

test('entry overflow halts capture, remains bounded and marks evidence unknown', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0, maxEntries: 2 });
  assert.equal(recorder.record('queue_enter'), true);
  assert.equal(recorder.record('wire_send'), true);
  assert.equal(recorder.record('ack_received'), false);
  for (let index = 0; index < 1000; index++) assert.equal(recorder.record('ack_received'), false);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.status, 'unknown');
  assert.equal(snapshot.reason, 'overflow');
  assert.equal(snapshot.entries.length, 2);
  assert.deepEqual(snapshot.counts, { recorded: 2, rejected: 0, dropped: 1 });
});

test('duration expires exactly at its bound and snapshot cannot silently retain a complete status', () => {
  let clock = 100;
  const recorder = measurement.createRecorder({ enabled: true, now: () => clock, maxDurationMs: 50 });
  clock = 149;
  assert.equal(recorder.record('sample_valid'), true);
  assert.equal(recorder.snapshot().status, 'ok');
  clock = 150;
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.reason, 'expired');
  assert.equal(snapshot.status, 'unknown');
  assert.equal(snapshot.active, false);
  assert.equal(recorder.record('health_published'), false);
});

test('a duration breach detected by record rejects that endpoint', () => {
  let clock = 0;
  const recorder = measurement.createRecorder({ enabled: true, now: () => clock, maxDurationMs: 5 });
  clock = 6;
  assert.equal(recorder.record('worker_received'), false);
  assert.equal(recorder.snapshot().reason, 'expired');
  assert.equal(recorder.snapshot().entries.length, 0);
});

test('clock exceptions at creation, record, snapshot and stop never propagate', () => {
  assert.doesNotThrow(() => {
    const recorder = measurement.createRecorder({ enabled: true, now() { throw new Error('PRIVATE'); } });
    assert.equal(recorder.snapshot().reason, 'clock_unavailable');
    assert.equal(recorder.record('content_observed'), false);
  });
  for (const operation of ['record', 'snapshot', 'stop']) {
    let shouldThrow = false;
    const recorder = measurement.createRecorder({ enabled: true, now() { if (shouldThrow) throw new Error('PRIVATE'); return 0; } });
    shouldThrow = true;
    assert.doesNotThrow(() => operation === 'record' ? recorder.record('content_observed') : recorder[operation]());
    assert.ok(recorder.snapshot().issues.includes('clock_unavailable'));
    assert.equal(recorder.snapshot().status, 'unknown');
    assert.equal(JSON.stringify(recorder.snapshot()).includes('PRIVATE'), false);
  }
});

test('non-numeric, non-finite and negative clocks fail closed without coercion', () => {
  for (const value of [NaN, Infinity, -Infinity, -1, '10', null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    const recorder = measurement.createRecorder({ enabled: true, now: () => value });
    assert.equal(recorder.snapshot().reason, 'clock_invalid');
    assert.equal(recorder.record('sample_valid'), false);
  }
});

test('clock rollback changes generation and cannot mix new endpoints into the previous evidence', () => {
  let clock = 100;
  const recorder = measurement.createRecorder({ enabled: true, now: () => clock });
  assert.equal(recorder.record('content_observed'), true);
  clock = 99;
  assert.equal(recorder.record('worker_received'), false);
  clock = 200;
  assert.equal(recorder.record('desktop_committed'), false);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.reason, 'clock_changed');
  assert.equal(snapshot.clockGeneration, 1);
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].clockGeneration, 0);
  assert.equal(snapshot.status, 'unknown');
});

test('stop is idempotent, marks evidence unknown and prevents later capture', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  assert.equal(recorder.record('content_observed'), true);
  assert.equal(recorder.stop().status, 'unknown');
  assert.equal(recorder.record('worker_received'), false);
  assert.equal(recorder.stop().reason, 'stopped');
  assert.deepEqual(recorder.snapshot().issues, ['stopped']);
});

test('explicit missing endpoint marks otherwise retained evidence unknown', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  assert.equal(recorder.record('ack_received', { missing: true }), true);
  assert.equal(recorder.snapshot().status, 'unknown');
  assert.equal(recorder.snapshot().reason, 'missing');
});

test('snapshot copies allow mutation without throwing or changing retained entries and counts', () => {
  const recorder = measurement.createRecorder({ enabled: true, now: () => 0 });
  recorder.record('content_observed', { status: 'ok', sameScope: true });
  const snapshot = recorder.snapshot();
  assert.doesNotThrow(() => {
    snapshot.entries[0].stage = 'PRIVATE';
    snapshot.entries[0].at = -10;
    snapshot.entries.push({ text: 'PRIVATE' });
    snapshot.counts.recorded = 999;
    snapshot.stages.content_observed = 999;
    snapshot.issues.push('PRIVATE');
    snapshot.active = false;
  });
  const next = recorder.snapshot();
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].stage, 'content_observed');
  assert.equal(next.entries[0].at, 0);
  assert.equal(next.counts.recorded, 1);
  assert.equal(next.stages.content_observed, 1);
  assert.equal(next.active, true);
  assert.equal(JSON.stringify(next).includes('PRIVATE'), false);
});

test('invalid configuration cannot enable capture or remove hard bounds', () => {
  const invalid = [null, [], 'yes', { enabled: 'yes' }, { enabled: true, now: null },
    { enabled: true, maxEntries: 0 }, { enabled: true, maxEntries: Infinity },
    { enabled: true, maxEntries: measurement.LIMITS.maxEntries + 1 },
    { enabled: true, maxDurationMs: 0 }, { enabled: true, maxDurationMs: Infinity },
    { enabled: true, maxDurationMs: measurement.LIMITS.maxDurationMs + 1 },
    { enabled: true, secret: 'PRIVATE' }, new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE'); } })];
  for (const options of invalid) {
    let recorder;
    assert.doesNotThrow(() => { recorder = measurement.createRecorder(options); });
    assert.equal(recorder.record('content_observed'), false);
    assert.equal(recorder.snapshot().reason, 'invalid_configuration');
    assert.equal(recorder.snapshot().enabled, false);
  }
});

test('bracket calibration returns a local-minus-external offset interval', () => {
  assert.deepEqual(measurement.calibrateExternalClock({ localBefore: 100, externalAt: 1000, localAfter: 110 }), {
    status: 'ok', reason: 'none', lower: -900, upper: -890, localGeneration: 0, externalGeneration: 0,
  });
  assert.deepEqual(measurement.calibrateExternalClock({ localBefore: 100, localAfter: 120,
    externalBefore: 1000, externalAfter: 1005, localGeneration: 2, externalGeneration: 3 }), {
    status: 'ok', reason: 'none', lower: -900, upper: -885, localGeneration: 2, externalGeneration: 3,
  });
});

test('calibration does not accept reversed clocks, impossible exchanges, missing or arbitrary data', () => {
  const invalid = [null, {}, { localBefore: 2, localAfter: 1, externalAt: 10 },
    { localBefore: 0, localAfter: 5, externalBefore: 10, externalAfter: 20 },
    { localBefore: 0, localAfter: 10, externalBefore: 20, externalAfter: 10 },
    { localBefore: 0, localAfter: 10, externalAt: Infinity },
    { localBefore: 0, localAfter: 10, externalAt: 20, externalBefore: 20 },
    { localBefore: 0, localAfter: 10, externalAt: 20, externalGeneration: -1 },
    { localBefore: 0, localAfter: 10, externalAt: 20, text: 'PRIVATE' }];
  for (const input of invalid) assert.equal(measurement.calibrateExternalClock(input).status, 'unknown');
  assert.doesNotThrow(() => measurement.calibrateExternalClock(new Proxy({}, { ownKeys() { throw new Error('PRIVATE'); } })));
});

test('delay intervals propagate clock uncertainty and require matching clock generations', () => {
  const calibration = measurement.calibrateExternalClock({ localBefore: 100, localAfter: 110,
    externalAt: 1000, localGeneration: 2, externalGeneration: 3 });
  assert.deepEqual(measurement.delayInterval({ start: 120, end: 1030, calibration,
    startGeneration: 2, endGeneration: 3 }), {
    status: 'ok', reason: 'none', lower: 10, upper: 20, clockGeneration: 2,
  });
  assert.equal(measurement.delayInterval({ start: 120, end: 1030, calibration,
    startGeneration: 2, endGeneration: 4 }).reason, 'clock_changed');
  assert.equal(measurement.delayInterval({ start: 1, end: 2, startGeneration: 1, endGeneration: 2 }).reason, 'clock_changed');
  assert.deepEqual(measurement.delayInterval({ start: { lower: 10, upper: 12 }, end: { lower: 11, upper: 20 } }), {
    status: 'ok', reason: 'none', lower: 0, upper: 10, clockGeneration: 0,
  });
  assert.equal(measurement.delayInterval({ start: 20, end: 10 }).status, 'unknown');
  assert.equal(measurement.delayInterval({ start: 0, end: 1, calibration: { status: 'unknown' } }).status, 'unknown');
});

test('delay judge uses inclusive upper deadline, strictly greater lower failure, otherwise unknown', () => {
  assert.equal(measurement.judgeDelayInterval({ lower: 9, upper: 10 }, 10), 'pass');
  assert.equal(measurement.judgeDelayInterval({ lower: 10, upper: 10 }, 10), 'pass');
  assert.equal(measurement.judgeDelayInterval({ lower: 10.001, upper: 11 }, 10), 'fail');
  assert.equal(measurement.judgeDelayInterval({ lower: 10, upper: 11 }, 10), 'unknown');
  assert.equal(measurement.judgeDelayInterval({ lower: 9, upper: 11 }, 10), 'unknown');
  assert.equal(measurement.judgeDelayInterval(measurement.delayInterval({ start: 1, end: 5 }), 4), 'pass');
});

test('delay judge fails closed for incomplete evidence and never propagates hostile input', () => {
  const invalid = [null, {}, { lower: null, upper: null }, { lower: 2, upper: 1 },
    { lower: -1, upper: 1 }, { lower: 0, upper: Infinity },
    { status: 'unknown', reason: 'expired', lower: 0, upper: 1 },
    { lower: 0, upper: 1, text: 'PRIVATE' },
    new Proxy({}, { ownKeys() { throw new Error('PRIVATE'); } })];
  for (const input of invalid) assert.doesNotThrow(() => {
    assert.equal(measurement.judgeDelayInterval(input, 10), 'unknown');
  });
  for (const deadline of [NaN, Infinity, -1, '10', null]) {
    assert.equal(measurement.judgeDelayInterval({ lower: 0, upper: 1 }, deadline), 'unknown');
  }
});
