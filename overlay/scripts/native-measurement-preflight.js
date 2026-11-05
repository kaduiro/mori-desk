/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Read-only category-only operational checks. This module cannot authorize a
// provider send or promote sampled DOM into uninterrupted physical evidence.
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const BLOCKERS = Object.freeze(['independent_dom_sample_event_link', 'independent_t0_lease_ready',
  'uninterrupted_one_second', 'claude_initial_view_witness', 'ui_application_endpoint', 'measurement_load_comparison']);
function assessNativePreflight(worker, desktop, expectedKit = null, previousWorker = null, options = {}) {
  const result = { schema: 1, operationalReady: false, generationTestReady: false, formalAcceptance: false,
    sourceLabelsAreLoadAttestation: false, sameChannelVerified: false,
    category: 'invalid_exports', checks: {}, blockers: [...BLOCKERS] };
  if (worker?.v !== 1 || worker.environment !== 'native_chrome_capture' || desktop?.schema !== 1
    || !Array.isArray(worker.records) || worker.records.length > 16384
    || !Array.isArray(desktop.events) || desktop.events.length > 16384
    || !Array.isArray(desktop.pings) || desktop.pings.length > 16384) return result;
  const w = worker.runtime, d = desktop.runtime, old = previousWorker?.runtime;
  const workerMetadata = hash(w?.buildFingerprint) && positive(w.generationOrdinal)
    && finite(w.clockOrigin) && finite(w.bootstrappedAt) && w.workerSelfReported === true && w.loadedArtifactVerified === false;
  const desktopMetadata = hash(d?.buildFingerprint) && hash(d?.kitSourceFingerprint)
    && positive(d.runGeneration) && d.collectorSelfReported === true && d.loadedArtifactVerified === false;
  const expected = hash(expectedKit?.measurementBuildFingerprint) && hash(expectedKit?.sourceFingerprint);
  const labels = workerMetadata && desktopMetadata && expected
    ? w.buildFingerprint === expectedKit.measurementBuildFingerprint
      && d.buildFingerprint === expectedKit.measurementBuildFingerprint && d.kitSourceFingerprint === expectedKit.sourceFingerprint : null;
  const generationChanged = workerMetadata && previousWorker?.v === 1 && previousWorker.environment === 'native_chrome_capture'
    && positive(old?.generationOrdinal) && finite(old.clockOrigin) && finite(old.bootstrappedAt)
    ? old.generationOrdinal !== w.generationOrdinal || old.clockOrigin !== w.clockOrigin || old.bootstrappedAt !== w.bootstrappedAt : null;
  const waiting = worker.capture?.phase === 'waiting' || desktop.capture?.phase === 'waiting';
  const remaining = capture => finite(capture?.remainingMs) && capture.remainingMs > 0;
  const recording = worker.capture?.phase === 'recording' && desktop.capture?.phase === 'recording'
    && worker.missing === false && worker.disposed === false && desktop.status === 'running'
    && worker.preflight?.canRecord === true && worker.preflight.transportReady === true
    && remaining(worker.capture) && remaining(desktop.capture);
  // Unique clock labels may correlate exports operationally. They are NOT an
  // exact ID comparison, a physical-channel attestation, or endpoint calibration.
  const pings = worker.records.filter(r => r?.kind === 'ping');
  let uniqueCommonPings = 0;
  const pairs = new Set();
  for (const ping of pings) {
    if (!finite(ping.pingAt) || !positive(ping.connectionOrdinal) || ping.recording !== true
      || !finite(ping.before) || !finite(ping.after) || ping.after < ping.before
      || pings.filter(p => p?.pingAt === ping.pingAt).length !== 1) continue;
    const found = desktop.pings.filter(p => p?.at === ping.pingAt);
    if (found.length !== 1 || found[0].unique !== true || found[0].missing !== false
      || !positive(found[0].connectionOrdinal)) continue;
    pairs.add(`${ping.connectionOrdinal}/${found[0].connectionOrdinal}`); uniqueCommonPings++;
  }
  result.checks = { workerMetadataAvailable: !!workerMetadata, desktopMetadataAvailable: !!desktopMetadata,
    expectedKitAvailable: !!expected, expectedSourceLabelsMatch: labels, workerGenerationChanged: generationChanged,
    recordingWithTimeRemaining: !!recording, uniqueCommonPings, anonymousConnectionPairs: pairs.size,
    sameRunClockLabelsAvailable: uniqueCommonPings >= 2 && pairs.size === 1,
    previousGenerationCheckAvailable: generationChanged !== null };
  const newGenerationRequired = options.requireNewWorkerGeneration === true;
  result.checks.newWorkerGenerationRequired = newGenerationRequired;
  result.operationalReady = labels === true && recording && result.checks.sameRunClockLabelsAvailable
    && (!newGenerationRequired || generationChanged === true);
  result.category = !workerMetadata || !desktopMetadata ? 'runtime_metadata_unavailable'
    : !expected ? 'expected_kit_unavailable' : labels !== true ? 'source_label_mismatch'
    : worker.missing === true || desktop.status === 'unknown' ? 'capture_invalid'
    : newGenerationRequired && generationChanged !== true ? 'new_worker_generation_unverified'
    : waiting ? 'waiting_for_authenticated_recording' : !recording ? 'recording_not_ready'
    : !result.checks.sameRunClockLabelsAvailable ? 'clock_label_link_unavailable' : 'operational_checks_available';
  return result;
}
module.exports = { assessNativePreflight };
