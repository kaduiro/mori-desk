/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessNativePreflight } = require('../scripts/native-measurement-preflight');
const { ackCoverage, analyzeNativeMeasurement, causalWorkerBracket } = require('../scripts/analyze-native-measurement');
const fp = 'a'.repeat(64), source = 'b'.repeat(64);
function inputs() {
  return [{ v: 1, environment: 'native_chrome_capture', missing: false, disposed: false,
    runtime: { buildFingerprint: fp, generationOrdinal: 1, clockOrigin: 100, bootstrappedAt: 101,
      workerSelfReported: true, loadedArtifactVerified: false },
    preflight: { canRecord: true, transportReady: true }, capture: { phase: 'recording', remainingMs: 10000 },
    records: [1, 2].map(n => ({ kind: 'ping', recording: true, pingAt: n * 1000, before: n * 10, after: n * 10 + 2, connectionOrdinal: 1 })) },
  { schema: 1, status: 'running', runtime: { buildFingerprint: fp, kitSourceFingerprint: source, runGeneration: 42,
    collectorSelfReported: true, loadedArtifactVerified: false }, capture: { phase: 'recording', remainingMs: 9000 }, events: [],
    pings: [1, 2].map(n => ({ at: n * 1000, connectionOrdinal: 3, unique: true, missing: false })) },
  { measurementBuildFingerprint: fp, sourceFingerprint: source }];
}
test('operational preflight is distinct from same-channel identity and formal generation readiness', () => {
  const args = inputs(), result = assessNativePreflight(...args);
  assert.equal(result.operationalReady, true);
  assert.equal(result.category, 'operational_checks_available');
  assert.equal(result.generationTestReady, false);
  assert.equal(result.sameChannelVerified, false);
  assert.equal(result.formalAcceptance, false);
  assert.equal(result.sourceLabelsAreLoadAttestation, false);
  assert.equal(result.checks.workerGenerationChanged, null);
  const previous = structuredClone(args[0]);
  assert.equal(assessNativePreflight(...args, previous).checks.workerGenerationChanged, false);
  assert.equal(assessNativePreflight(...args, previous, { requireNewWorkerGeneration: true }).operationalReady, false);
  assert.equal(assessNativePreflight(...args, null, { requireNewWorkerGeneration: true }).operationalReady, false);
  previous.runtime.clockOrigin--;
  assert.equal(assessNativePreflight(...args, previous).checks.workerGenerationChanged, true);
  assert.equal(assessNativePreflight(...args, previous, { requireNewWorkerGeneration: true }).operationalReady, true);
});
for (const problem of ['old_worker', 'old_collector', 'wrong_kit', 'expired', 'waiting', 'missing', 'duplicate_ping', 'multiple_connections', 'legacy']) {
  test(`preflight rejects operational readiness for ${problem}`, () => {
    const [w, d, kit] = inputs();
    if (problem === 'old_worker') w.runtime.buildFingerprint = 'c'.repeat(64);
    if (problem === 'old_collector') d.runtime.buildFingerprint = 'c'.repeat(64);
    if (problem === 'wrong_kit') d.runtime.kitSourceFingerprint = 'c'.repeat(64);
    if (problem === 'expired') d.capture.remainingMs = 0;
    if (problem === 'waiting') w.capture.phase = 'waiting';
    if (problem === 'missing') w.missing = true;
    if (problem === 'duplicate_ping') d.pings.push({ ...d.pings[0] });
    if (problem === 'multiple_connections') w.records[1].connectionOrdinal = 2;
    if (problem === 'legacy') delete w.runtime;
    const result = assessNativePreflight(w, d, kit);
    assert.equal(result.operationalReady, false);
    assert.equal(result.formalAcceptance, false);
  });
}
test('unknown ACK information remains unknown, while new fixed reasons are counted without secrets', () => {
  const raw = n => ({ kind: 'raw_ack', connectionOrdinal: 1, eventOrdinal: n });
  const old = ackCoverage([raw(1), raw(2), { kind: 'current_ack', connectionOrdinal: 1, eventOrdinal: 1 }]);
  assert.equal(old.unexplainedWithoutCurrentHook, 1);
  assert.equal(old.proofUnavailableWithoutCurrentHook, 0);
  const next = ackCoverage([{ ...raw(1), proofPresent: false, replay: true }, raw(2),
    { kind: 'ack_decision', connectionOrdinal: 1, eventOrdinal: 2, gate: 'lease_missing', proofPresent: true, replay: false, sameConnection: true },
    { kind: 'ack_decision', connectionOrdinal: 1, eventOrdinal: 3, gate: 'PRIVATE_TOKEN', proofPresent: true, replay: false, sameConnection: true }]);
  assert.equal(next.unexplainedWithoutCurrentHook, 0);
  assert.equal(next.gates.lease_missing, 1);
  assert.equal(JSON.stringify(next).includes('PRIVATE_TOKEN'), false);
  assert.equal(next.formalAcceptance, false);
});
test('read-before-write evidence never becomes a commit endpoint or a formal verdict', () => {
  const [w, d, kit] = inputs();
  d.events = [{ durableRead: [1, 2], ackSent: [3, 4] }, { durableRead: [3, 4], ackSent: [1, 2] }, {}];
  const result = analyzeNativeMeasurement(w, d, { expectedKit: kit });
  assert.equal(result.preflight.operationalReady, true);
  assert.deepEqual(result.evidence.desktopReadWriteEvidence, { readPrecedesAckWrite: 1, orderUnknown: 2,
    provesFsyncCommitEndpoint: false, provesWorkerValidation: false });
  assert.equal(result.productFixRequired, null);
  assert.equal(result.formalAcceptance, false);
  assert.ok(!result.missing.includes('kernel_ack_send_endpoint'));
});
test('malformed and private values cannot escape preflight output', () => {
  const [w, d, kit] = inputs();
  w.runtime.buildFingerprint = 'PRIVATE_TOKEN'; d.runtime.runGeneration = 'PRIVATE_TOKEN';
  const result = assessNativePreflight(w, d, kit);
  assert.equal(result.operationalReady, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false);
  assert.equal(assessNativePreflight(null, null).category, 'invalid_exports');
});
test('causal bracket needs surrounding ping exchanges without a constant-offset assumption', () => {
  const pairs = [{ before: 10, after: 20, received: [1000, 1001], pongSent: [1002, 1003] },
    { before: 70, after: 80, received: [1030, 1031], pongSent: [1032, 1033] }];
  assert.deepEqual(causalWorkerBracket([40, 60], pairs), [1002, 1031]);
  assert.equal(causalWorkerBracket([5, 60], pairs), null);
  assert.equal(causalWorkerBracket([40, 90], pairs), null);
  assert.equal(causalWorkerBracket([60, 40], pairs), null);
  assert.equal(causalWorkerBracket([40, 60], [pairs[0]]), null);
  assert.equal(causalWorkerBracket([40, 60], [{ ...pairs[0], pongSent: [1100, 1101] }, pairs[1]]), null);
});
