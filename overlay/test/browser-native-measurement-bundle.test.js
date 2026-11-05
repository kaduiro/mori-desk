/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildNativeBundle, replaceOne } = require('../scripts/native-measurement-bundle');
const { analyzeNativeMeasurement, offsetFor, bracketTransition } = require('../scripts/analyze-native-measurement');

test('native bundle is separate, preserves source bytes and ordinary permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mori-native-bundle-test-'));
  try {
    const runtime = path.resolve(__dirname, '..');
    const source = path.join(runtime, 'extensions/browser-bridge');
    const original = fs.readFileSync(path.join(source, 'manifest.json'));
    const before = fs.readFileSync(path.join(source, 'service-worker.js'));
    const output = path.join(dir, 'extension');
    const result = buildNativeBundle({ runtime, output });
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')));
    const ordinary = JSON.parse(original);
    assert.match(result.extensionId, /^[a-p]{32}$/);
    assert.match(result.measurementBuildFingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(manifest.key, ordinary.key);
    assert.deepEqual(manifest.permissions, ordinary.permissions);
    assert.deepEqual(manifest.host_permissions, ordinary.host_permissions);
    assert.equal(manifest.version, ordinary.version);
    assert.equal(manifest.background.service_worker, 'native-worker-entry.js');
    assert.ok(manifest.content_scripts[0].js.includes('native-independent-witness.js'));
    assert.equal(fs.readFileSync(path.join(source, 'manifest.json')).equals(original), true);
    assert.equal(fs.readFileSync(path.join(source, 'service-worker.js')).equals(before), true);
    const worker = fs.readFileSync(path.join(output, 'native-worker-entry.js'), 'utf8');
    assert.ok(worker.includes('nativeWorkerCapture.WebSocketClass'));
    assert.ok(worker.includes(JSON.stringify(result.measurementBuildFingerprint)));
    const same = buildNativeBundle({ runtime, output:path.join(dir,'second') });
    assert.equal(same.measurementBuildFingerprint,result.measurementBuildFingerprint);
    assert.equal(worker.includes('const measurement = null;'), false);
    new vm.Script(worker);
    new vm.Script(fs.readFileSync(path.join(output, 'content-script.js'), 'utf8'));
    new vm.Script(fs.readFileSync(path.join(output, 'native-options.js'), 'utf8'));
    assert.equal(Object.keys(result.hashes).length, 9);
    assert.equal(result.targetPingOrdinal, 2);
    assert.ok(manifest.content_scripts[0].js.indexOf('native-payload.js')
      < manifest.content_scripts[0].js.indexOf('native-measurement-content.js'));
    assert.ok(worker.includes("importScripts('native-payload.js', 'native-channel.js', 'native-measurement-worker.js')"));
    for (const name of ['native-payload.js','native-channel.js'])
      assert.ok(fs.readFileSync(path.join(output,name)).length > 0);
    for (const hash of Object.values(result.hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
    assert.throws(() => buildNativeBundle({ runtime, output }), /native_bundle_directory/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bundle exact seams fail closed', () => {
  assert.throws(() => replaceOne('none', 'needle', 'x'));
  assert.throws(() => replaceOne('aa', 'a', 'x'));
  assert.equal(replaceOne('a needle b', 'needle', 'x'), 'a x b');
});
test('clock bounds include receive and send uncertainty outwards', () => {
  assert.deepEqual(offsetFor({ before: 1, after: 5 }, { received: [6, 7], pongSent: [8, 9] }), [3, 6]);
  assert.equal(offsetFor({ before: 5, after: 1 }, { received: [6, 7], pongSent: [8, 9] }), null);
  assert.equal(offsetFor({ before: 1, after: 5 }, { received: [9, 10], pongSent: [8, 9] }), null);
});
const ping = (before, after, at, connectionOrdinal = 1) => ({ kind: 'ping', before, after, pingAt: at, connectionOrdinal });
const desktopPing = (at, start, connectionOrdinal = 1) => ({ at, received: [start, start + 1], pongSent: [start + 1, start + 2], connectionOrdinal, unique: true, missing: false });
function exportsForAnalysis() {
  return [{ v: 1, environment: 'native_chrome_capture', missing: false, records: [ping(0, 4, 100), ping(100, 104, 200),
    { kind: 'event_sent', connectionOrdinal: 1, eventOrdinal: 1, before: 50 }] },
  { schema: 1, status: 'running', pings: [desktopPing(100, 11), desktopPing(200, 111)],
    events: [{ connectionOrdinal: 1, eventOrdinal: 1, received: [61, 62] }] }];
}
test('native analysis keeps anonymous ordinal segment separate from product verdict', () => {
  const [worker, desktop] = exportsForAnalysis();
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.category, 'partial_native_timing_available');
  assert.deepEqual(result.clocks[0].offset, [8, 12]);
  assert.deepEqual(result.segments[0].delayMs, [-1, 4]);
  assert.equal(result.segments[0].identityVerified, false);
  assert.equal(result.segments[0].deadlineVerdict, 'unknown');
  assert.equal(result.formalAcceptance, false);
  assert.equal(result.productFixRequired, null);
});
for (const problem of ['missing', 'duplicate', 'reconnect', 'jump', 'no-end-probe']) {
  test(`native analysis retains unknown for ${problem}`, () => {
    const [worker, desktop] = exportsForAnalysis();
    if (problem === 'missing') worker.missing = true;
    if (problem === 'duplicate') desktop.pings.push({ ...desktop.pings[0] });
    if (problem === 'reconnect') worker.records.push(ping(0, 4, 100, 2));
    if (problem === 'jump') desktop.pings[1] = desktopPing(200, 999);
    if (problem === 'no-end-probe') worker.records.splice(1, 1);
    const result = analyzeNativeMeasurement(worker, desktop);
    assert.equal(result.formalAcceptance, false);
    assert.equal(result.productFixRequired, null);
    assert.ok(result.segments.every(s => s.deadlineVerdict === 'unknown'));
    assert.ok(result.segments.every(s => s.delayMs === null));
  });
}
test('unknown input text and identifier fields never echo to diagnostic output', () => {
  const result = analyzeNativeMeasurement({ v: 1, environment: 'native_chrome_capture', records: [{ kind: 'private', requestPreview: 'SECRET_MARKER' }] },
    { schema: 1, pings: [], events: [{ clientId: 'SECRET_MARKER' }] });
  assert.equal(JSON.stringify(result).includes('SECRET_MARKER'), false);
  assert.equal(analyzeNativeMeasurement(null, null).category, 'invalid_export_shape');
});
test('transition interval begins at prior negative read, never first positive time', () => {
  const previous = { before: 0, after: 2, state: 'quiet' };
  const current = { before: 100, after: 103, state: 'running', sameScope: true };
  assert.deepEqual(bracketTransition(previous, current), [0, 103]);
  assert.equal(bracketTransition(null, current), null);
  assert.equal(bracketTransition(previous, { ...current, after: 251 }), null);
  assert.equal(bracketTransition(previous, { ...current, state: 'running', sameScope: false }), null);
});
test('composed DOM window requires bracketing clocks on both process boundaries', () => {
  const [worker, desktop] = exportsForAnalysis();
  worker.records.push(
    { kind: 'content_clock', tabOrdinal: 1, documentOrdinal: 1, clockOrigin: 1,
      before: 5, received: 15, sent: 16, after: 7 },
    { kind: 'content_clock', tabOrdinal: 1, documentOrdinal: 1, clockOrigin: 1,
      before: 90, received: 100, sent: 101, after: 92 },
    { kind: 'dom', tabOrdinal: 1, documentOrdinal: 1, before: 45, after: 46, state: 'quiet', sameScope: true },
    { kind: 'dom', tabOrdinal: 1, documentOrdinal: 1, before: 55, after: 56, state: 'running', sameScope: true });
  let result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.transitions.length, 1);
  assert.ok(result.transitions[0].desktopClockWindow);
  assert.equal(result.transitions[0].deadlineVerdict, 'unknown');
  worker.records = worker.records.filter(r => r.kind !== 'ping' || r.before !== 0);
  result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.transitions[0].desktopClockWindow, null);
  worker.records = worker.records.filter(r => r.kind !== 'content_clock' || r.before !== 5);
  assert.equal(analyzeNativeMeasurement(worker, desktop).transitions[0].desktopClockWindow, null);
});
test('diagnostic summary distinguishes structural unknown from missing capture and absent endpoints', () => {
  const [worker, desktop] = exportsForAnalysis();
  worker.missing = true;
  worker.records.push({ kind: 'dom', state: 'unknown', reason: 'owner_not_unique' },
    { kind: 'dom', state: 'unknown', reason: 'document_not_visible' },
    { kind: 'content_stage', stage: 'registration_result', recording: true, status: 'failed', reason: 'scope_unconfirmed' });
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.evidence.domSamples, 2);
  assert.equal(result.evidence.knownDomSamples, 0);
  assert.equal(result.evidence.workerMissing, true);
  assert.deepEqual(result.evidence.domReasons, { owner_not_unique: 1, document_not_visible: 1 });
  assert.equal(result.evidence.registrationsFailed, 1);
  assert.equal(result.evidence.leasesReceived, 0);
  assert.equal(result.evidence.matchedPingLabels, 2);
  assert.equal(result.productFixRequired, null);
});
test('waiting samples and clock probes are not promoted to recording evidence', () => {
  const [worker, desktop] = exportsForAnalysis();
  worker.capture = { phase: 'waiting', startedAt: null, maxDurationMs: 600000, maxEntries: 100, elapsedMs: null, lastRecordAt: 2 };
  for (const r of worker.records) r.recording = false;
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.evidence.workerCapture.phase, 'waiting');
  assert.equal(result.evidence.workerCapture.startedAt, null);
  assert.equal(result.clocks.length, 0);
  assert.equal(result.formalAcceptance, false);
  worker.records.push({ kind: 'dom', recording: false, state: 'quiet', scopeKind: 'conversation', reason: 'observed' },
    { kind: 'dom', recording: true, state: 'quiet', scopeKind: 'unknown', reason: 'observed' });
  const evidence = analyzeNativeMeasurement(worker, desktop).evidence;
  assert.equal(evidence.domByPhase.not_recording.total, 1);
  assert.equal(evidence.knownDomSamples, 0);
});
test('anonymous retired-probe gaps and failed probes never become clock measurements',()=>{
  const [worker,desktop]=exportsForAnalysis();
  const base={tabOrdinal:1,documentOrdinal:2,probeOrdinal:3,before:10,after:11,recording:false};
  worker.records.push({...base,kind:'content_clock_gap',reason:'activation_changed'},
    {...base,kind:'content_clock_failure',reason:'clock_probe_failed',stage:'response'},
    {...base,kind:'content_clock_gap',reason:'loading',privateText:'PRIVATE'},
    {...base,kind:'content_clock_failure',reason:'clock_probe_failed',stage:'timeout'});
  const result=analyzeNativeMeasurement(worker,desktop),d=result.evidence.clockProbeDiagnostics;
  assert.equal(d.gaps.length,1);assert.equal(d.failures.length,1);assert.equal(d.invalidRows,2);
  assert.equal(d.clockGapsAreMeasurements,false);assert.equal(d.provesCurrentDocument,false);assert.equal(d.provesCompletion,false);
  assert.doesNotMatch(JSON.stringify(d),/PRIVATE/);assert.equal(result.formalAcceptance,false);
});
test('structure inventory is copied by fixed numeric fields without establishing a binding', () => {
  const { inspectStructureInventory } = require('../scripts/monitoring-independent-witness');
  const inventory = inspectStructureInventory({ provider: 'chatgpt', document: { visibilityState: 'visible',
    querySelectorAll: () => [] }, readRoute: () => 'https://chatgpt.com/c/PRIVATE_ROUTE' });
  const [worker, desktop] = exportsForAnalysis();
  worker.records.push({ kind: 'structure_inventory', tabOrdinal: 1, documentOrdinal: 1,
    before: 50, after: 51, recording: true, inventory: { ...inventory, requestPreview: 'PRIVATE_TEXT' } });
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.structureInventories.length, 1);
  assert.equal(result.structureInventories[0].routeKind, 'conversation');
  assert.equal(result.structureInventories[0].provesConversationBinding, false);
  assert.equal(result.structureInventories[0].currentDocumentVerified, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(result.evidence.structureInventories, { received: 1, valid: 1, rejected: 0, category: 'available' });
  assert.equal(result.formalAcceptance, false);
});
test('inventory absence, invalid records and observed zero counts remain distinct', () => {
  const [worker, desktop] = exportsForAnalysis();
  assert.deepEqual(analyzeNativeMeasurement(worker, desktop).evidence.structureInventories,
    { received: 0, valid: 0, rejected: 0, category: 'not_collected' });
  worker.records.push({ kind: 'structure_inventory', tabOrdinal: 1, documentOrdinal: 1,
    before: 1, after: 2, inventory: { provider: 'chatgpt', routeKind: 'conversation', visible: true, counts: {} } });
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.deepEqual(result.evidence.structureInventories,
    { received: 1, valid: 0, rejected: 1, category: 'invalid_records' });
  assert.deepEqual(result.structureInventories, []);
  assert.equal(result.productFixRequired, null);
  assert.equal(result.formalAcceptance, false);
});
test('failure-tainted false records are not called waiting and legacy failure zeros are unavailable', () => {
  const [worker, desktop] = exportsForAnalysis();
  worker.missing = true;
  worker.capture = { phase: 'unknown', startedAt: 5 };
  worker.records.push({ kind: 'dom', recording: false, before: 10, after: 11, state: 'unknown', reason: 'document_not_visible' });
  worker.contentFailures = [{ tabOrdinal: 1, documentOrdinal: 1, failures: {} },
    { tabOrdinal: 2, documentOrdinal: 2, batchVersions: { v1: 1, v2: 2 }, failureReporting: 'mixed', failures: {} }];
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.equal(result.evidence.domByPhase.not_recording.total, 1);
  assert.equal(Object.hasOwn(result.evidence.domByPhase, 'waiting'), false);
  assert.equal(result.evidence.contentFailures[0].failureReporting, 'unavailable');
  assert.equal(result.evidence.contentFailures[1].failureReporting, 'mixed');
  assert.equal(result.evidence.contentFailures[1].acceptedV2Batches, null);
  assert.equal(result.evidence.contentFailures[1].absenceOfFailuresProven, false);
  assert.equal(result.formalAcceptance, false);
});
test('receiving only v2 packets does not imply accepted failure reports', () => {
  const [worker, desktop] = exportsForAnalysis();
  worker.contentFailures = [{ tabOrdinal: 1, documentOrdinal: 1, batchVersions: { v1: 0, v2: 2 },
    batchResults: { v1: { accepted: 0, rejected: 0 }, v2: { accepted: 0, rejected: 2 } },
    failureReporting: 'v2_only', failures: {} }];
  const row = analyzeNativeMeasurement(worker, desktop).evidence.contentFailures[0];
  assert.equal(row.failureReporting, 'v2_only');
  assert.equal(row.acceptedV2Batches, 0);
  assert.equal(row.batchResults.v2.rejected, 2);
  assert.equal(row.absenceOfFailuresProven, false);
});
test('incomplete socket closures retain fixed counts without echoing unknown fields', () => {
  const [worker, desktop] = exportsForAnalysis();
  assert.equal(analyzeNativeMeasurement(worker, desktop).evidence.workerSocketClosures, null);
  worker.socketClosures = { incomplete: 1, pendingEvents: 2, pendingCurrentAcks: 0, pendingPings: 1, secret: 'PRIVATE' };
  worker.failures = { socket_evidence_incomplete: { count: 1, firstAt: 10, lastAt: 10 } };
  const result = analyzeNativeMeasurement(worker, desktop);
  assert.deepEqual(result.evidence.workerSocketClosures, { incomplete: 1, pendingEvents: 2, pendingCurrentAcks: 0, pendingPings: 1 });
  assert.equal(result.evidence.workerFailures.socket_evidence_incomplete.count, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.formalAcceptance, false);
});
