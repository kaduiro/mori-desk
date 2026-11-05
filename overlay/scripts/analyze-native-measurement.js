/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
// Offline analysis of category-only exports. No connection to Chrome or Mori.
const fs = require('node:fs');
const { assessNativePreflight } = require('./native-measurement-preflight');
const { analyzeChannelEvidence, analyzeSeriesEvidence } = require('./monitoring-independent-analysis');
const { dictionary: diagnosticDictionary } = require('./monitoring-independent-payload');
const finite = n => typeof n === 'number' && Number.isFinite(n);
const ordinal = n => Number.isSafeInteger(n) && n > 0;
const interval = value => Array.isArray(value) && value.length === 2
  && value.every(finite) && value[0] <= value[1];
const MAX_RECORDS = 16384;
const DOM_REASONS = ['observed','main_not_unique','owner_not_unique','owner_mismatch','editor_not_unique','form_unconfirmed',
  'mixed_message_owner','generation_ambiguous','route_owner_mismatch','generation_marker_partial','loading_or_transition',
  'composer_not_unique','editor_unconfirmed','generation_marker_unknown','disposed','document_not_visible',
  'route_transition_unconfirmed','clock_discontinuity','structure_unavailable'];
const FAILURE_CATEGORIES = ['clock_unavailable','clock_invalid','clock_reversed','expired','capacity','invalid_schema','invalid_sender',
  'clock_probe_failed','clock_probe_timeout','clock_probe_capacity','batch_missing','batch_rejected','batch_timeout','batch_send_failed',
  'batch_gap','batch_duplicate','reader_failed','reader_dispose_failed','socket_send_failed','ack_unmatched','ack_ambiguous',
  'ping_duplicate','ping_unmatched','sample_duplicate','capture_failed','disposed','batch_retry_exhausted','structure_inventory_failed','socket_evidence_incomplete',
  'b1_missing_hook','b1_input_conflict','b1_invocation_missing','b1_event_conflict','b1_clone_unverified','b1_send_unverified','b1_pending_expired','b1_stale_capture'];
const INVENTORY_KEYS = ['main','form','editable','textbox','prompt','stop','busy','streaming','assistantMarker','conversationTurn',
  'chatgptOwner','chatgptComposerOwner','chatgptMessageOwner','claudeHubRoot','claudeInput','conversationId','chatId','threadId','canonical'];
const ACK_GATES = ['control_generation_changed','credential_changed','proof_absent','disposition_not_current','replay',
  'session_not_current','transport_not_ready','connection_changed','lease_missing','lease_generation_changed','page_changed',
  'document_changed','lease_scope_changed','observation_not_fresh','sequence_changed','event_time_invalid','event_expired',
  'sample_time_invalid','sample_expired','accepted_current','unclassified'];
const REGISTRATION_REASONS = ['none','unclassified','stopped','runtime_unavailable','message_failed','registration_replaced',
  'page_changed','binding_changed','route_changed','paused','invalid_sender','old_document','invalid_observation',
  'old_observation','duplicate_observation','capacity','outbox_full','storage_failed','local_data_invalid','tab_unavailable',
  'observation_failed','binding_unconfirmed','lease_invalid','lease_expired','attempt_expired','observer_version',
  'initialization_failed','registration_failed','observer_queue_full','ack_unavailable','peer_unsupported','scope_unconfirmed'];
function inventorySummary(record) {
  const i = record?.inventory;
  if (!ordinal(record?.tabOrdinal) || !ordinal(record?.documentOrdinal) || !finite(record.before) || !finite(record.after)
    || record.after < record.before || !i || !['chatgpt', 'claude'].includes(i.provider)
    || !['conversation', 'view'].includes(i.routeKind) || typeof i.visible !== 'boolean') return null;
  const counts = {};
  for (const name of INVENTORY_KEYS) {
    const row = i.counts?.[name];
    if (!row || !['found', 'visible', 'matchesCurrentRoute'].every(k => Number.isSafeInteger(row[k]) && row[k] >= 0 && row[k] <= 200)
      || row.visible > row.found || row.matchesCurrentRoute > row.found || typeof row.capped !== 'boolean') return null;
    counts[name] = { found: row.found, visible: row.visible, matchesCurrentRoute: row.matchesCurrentRoute, capped: row.capped };
  }
  return { tabOrdinal: record.tabOrdinal, documentOrdinal: record.documentOrdinal,
    phase: record.recording === true ? 'recording' : record.recording === false ? 'not_recording' : 'unspecified',
    contentClockWindow: [record.before, record.after], provider: i.provider, routeKind: i.routeKind,
    visible: i.visible, counts, provesConversationBinding: false, currentDocumentVerified: false };
}
function failureSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const category of FAILURE_CATEGORIES) {
    const row = value[category];
    if (!row || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 1000000) continue;
    result[category] = { count: row.count,
      firstAt: finite(row.firstAt) && row.firstAt >= 0 ? row.firstAt : null,
      lastAt: finite(row.lastAt) && row.lastAt >= 0 ? row.lastAt : null };
  }
  return result;
}
function captureSummary(value) {
  if (!value || !['waiting', 'recording', 'unknown'].includes(value.phase)) return null;
  const result = { phase: value.phase };
  for (const name of ['startedAt', 'maxDurationMs', 'maxEntries', 'elapsedMs', 'lastRecordAt', 'remainingMs'])
    result[name] = finite(value[name]) && value[name] >= 0 ? value[name] : null;
  return result;
}
function contentFailureSummary(value) {
  if (!Array.isArray(value) || value.length > 64) return [];
  return value.filter(row => ordinal(row?.tabOrdinal) && ordinal(row?.documentOrdinal)).map(row => {
    const versions = row.batchVersions;
    const versionKeys = versions && Object.hasOwn(versions,'v3') ? ['v1','v2','v3'] : ['v1','v2'];
    const validVersions = versions && versionKeys.every(k => Number.isSafeInteger(versions[k]) && versions[k] >= 0 && versions[k] <= 1000000);
    const active = validVersions ? versionKeys.filter(k=>versions[k]>0) : [];
    const expected = !validVersions ? 'unavailable' : active.length>1 ? 'mixed' : active[0]==='v1' ? 'legacy_only' : active.length ? `${active[0]}_only` : 'none';
    const validResults = validVersions && versionKeys.every(v => ['accepted', 'rejected'].every(k =>
      Number.isSafeInteger(row.batchResults?.[v]?.[k]) && row.batchResults[v][k] >= 0 && row.batchResults[v][k] <= 1000000)
      && row.batchResults[v].accepted + row.batchResults[v].rejected <= versions[v]);
    return { tabOrdinal: row.tabOrdinal, documentOrdinal: row.documentOrdinal,
      failureReporting: row.failureReporting === expected ? expected : 'unavailable',
      batchVersions: validVersions ? Object.fromEntries(versionKeys.map(v=>[v,versions[v]])) : null,
      batchResults: validResults ? Object.fromEntries(versionKeys.map(v => [v,
        { accepted: row.batchResults[v].accepted, rejected: row.batchResults[v].rejected }])) : null,
      acceptedV2Batches: validResults ? row.batchResults.v2.accepted : null,
      acceptedV3Batches: validResults && versionKeys.includes('v3') ? row.batchResults.v3.accepted : null,
      absenceOfFailuresProven: false,
      failures: failureSummary(row.failures) };
  });
}
function socketClosureSummary(value) {
  const keys = ['incomplete', 'pendingEvents', 'pendingCurrentAcks', 'pendingPings'];
  if (!value || !keys.every(k => Number.isSafeInteger(value[k]) && value[k] >= 0 && value[k] <= 1000000)) return null;
  return Object.fromEntries(keys.map(k => [k, value[k]]));
}
function clockProbeDiagnostics(records) {
  const gaps=[],failures=[];let invalidRows=0;
  for(const row of records){
    if(!['content_clock_gap','content_clock_failure'].includes(row?.kind))continue;
    const isFailure=row.kind==='content_clock_failure';
    const keys=['kind','tabOrdinal','documentOrdinal','probeOrdinal','before','after','reason','recording',...(isFailure?['stage']:[])];
    const r=diagnosticDictionary(row,keys);
    const valid=r&&ordinal(r.tabOrdinal)&&ordinal(r.documentOrdinal)&&(r.probeOrdinal===null||ordinal(r.probeOrdinal))
      &&finite(r.before)&&r.before>=0&&finite(r.after)&&r.after>=r.before&&r.recording===false;
    const categories={capacity:'clock_probe_capacity',unavailable:'clock_probe_failed',request:'clock_probe_failed',response:'clock_probe_failed',timeout:'clock_probe_timeout'};
    if(!valid || (isFailure ? !Object.hasOwn(categories,r.stage)||categories[r.stage]!==r.reason
      : !['loading','discarded','frozen','unsupported_origin','tab_closed','activation_changed'].includes(r.reason))){invalidRows++;continue;}
    (isFailure?failures:gaps).push(r);
  }
  return {gaps,failures,invalidRows,clockGapsAreMeasurements:false,provesCurrentDocument:false,provesCompletion:false};
}
function ackCoverage(records) {
  const raw = records.filter(r => r?.kind === 'raw_ack');
  const current = records.filter(r => r?.kind === 'current_ack');
  const decisions = records.filter(r => r?.kind === 'ack_decision' && ACK_GATES.includes(r.gate)
    && typeof r.proofPresent === 'boolean' && typeof r.replay === 'boolean' && typeof r.sameConnection === 'boolean');
  const same = (a, b) => ordinal(a.connectionOrdinal) && ordinal(a.eventOrdinal)
    && a.connectionOrdinal === b.connectionOrdinal && a.eventOrdinal === b.eventOrdinal;
  const result = { raw: raw.length, current: current.length, withCurrentHook: 0, replayWithoutCurrentHook: 0,
    withoutCurrentHook: 0, proofUnavailableWithoutCurrentHook: 0, decisionRecordedWithoutCurrentHook: 0,
    unexplainedWithoutCurrentHook: 0, ambiguous: 0,
    gates: Object.fromEntries(ACK_GATES.map(gate => [gate, decisions.filter(r => r.gate === gate).length])), formalAcceptance: false };
  for (const ack of raw) {
    if (!ordinal(ack.connectionOrdinal) || !ordinal(ack.eventOrdinal) || raw.filter(r => same(ack, r)).length !== 1) {
      result.ambiguous++; continue;
    }
    const hooks = current.filter(r => same(ack, r));
    if (hooks.length > 1) { result.ambiguous++; continue; }
    if (hooks.length === 1) { result.withCurrentHook++; continue; }
    result.withoutCurrentHook++;
    // Older exports lack these facts. Missing is never interpreted as false.
    if (ack.replay === true) result.replayWithoutCurrentHook++;
    if (ack.proofPresent === false) result.proofUnavailableWithoutCurrentHook++;
    const matches = decisions.filter(r => same(ack, r));
    if (matches.length === 1) result.decisionRecordedWithoutCurrentHook++;
    else if (matches.length > 1) result.ambiguous++;
    if (ack.replay !== true && ack.proofPresent !== false && matches.length !== 1) result.unexplainedWithoutCurrentHook++;
  }
  return result;
}
function evidenceSummary(worker, desktop) {
  const records = worker.records;
  const count = kind => records.filter(r => r?.kind === kind).length;
  const stage = name => records.filter(r => r?.stage === name).length;
  const dom = records.filter(r => r?.kind === 'dom');
  // False includes pre-auth waiting AND failure-tainted rows after auth. The
  // aggregate boolean cannot recover which phase held at each endpoint.
  const phaseOf = r => r.recording === true ? 'recording' : r.recording === false ? 'not_recording' : 'unspecified';
  const domByPhase = {};
  for (const phase of ['recording', 'not_recording', 'unspecified']) {
    const rows = dom.filter(r => phaseOf(r) === phase);
    domByPhase[phase] = { total: rows.length,
      knownScopeState: rows.filter(r => ['view', 'conversation'].includes(r.scopeKind) && ['quiet', 'running'].includes(r.state)).length,
      unknownState: rows.filter(r => r.state === 'unknown').length };
  }
  const registrationsByPhase = {};
  for (const phase of ['recording', 'not_recording', 'unspecified']) {
    const rows = records.filter(r => r?.stage === 'registration_result' && phaseOf(r) === phase);
    registrationsByPhase[phase] = { succeeded: rows.filter(r => r.status === 'ok').length,
      failed: rows.filter(r => r.status === 'failed').length,
      reasons: Object.fromEntries(REGISTRATION_REASONS.map(reason => [reason, rows.filter(r => r.reason === reason).length])),
      reasonUnavailable: rows.filter(r => !REGISTRATION_REASONS.includes(r.reason)).length };
  }
  const reasons = {};
  for (const name of DOM_REASONS) {
    const n = dom.filter(r => r.reason === name).length;
    if (n) reasons[name] = n;
  }
  const pings = records.filter(r => r?.kind === 'ping');
  const matchedPings = pings.filter(p => finite(p.pingAt) && pings.filter(q => q.pingAt === p.pingAt).length === 1
    && desktop.pings.filter(q => q?.at === p.pingAt).length === 1).length;
  return { workerCapture: captureSummary(worker.capture), desktopCapture: captureSummary(desktop.capture),
    workerFailures: failureSummary(worker.failures), workerSocketClosures: socketClosureSummary(worker.socketClosures),
    contentFailures: contentFailureSummary(worker.contentFailures),clockProbeDiagnostics:clockProbeDiagnostics(records),
    workerMissing: worker.missing === true, workerRecords: records.length,
    domSamples: dom.length, knownDomSamples: domByPhase.recording.knownScopeState,
    unknownDomSamples: dom.filter(r => r.state === 'unknown').length, domByPhase, domReasons: reasons,
    observersInstalled: stage('observer_installed'), registrationsRequested: stage('registration_requested'),
    registrationsSucceeded: registrationsByPhase.recording.succeeded,
    registrationsFailed: registrationsByPhase.recording.failed, registrationsByPhase,
    leasesReceived: stage('lease_received'), observations: count('observation'),
    eventsSent: count('event_sent'), desktopEvents: desktop.events.length,
    desktopReadWriteEvidence: {
      readPrecedesAckWrite: desktop.events.filter(e => interval(e?.durableRead) && interval(e?.ackSent)
        && e.durableRead[1] <= e.ackSent[0]).length,
      orderUnknown: desktop.events.filter(e => !interval(e?.durableRead) || !interval(e?.ackSent)
        || e.durableRead[1] > e.ackSent[0]).length,
      provesFsyncCommitEndpoint: false, provesWorkerValidation: false },
    rawAcks: count('raw_ack'), currentAcks: count('current_ack'), ackCoverage: ackCoverage(records),
    productInspectionStarted: stage('product_inspection_started'), productInspectionFinished: stage('product_inspection_finished'),
    observerInstallationDeferred: stage('observer_install_deferred'),
    workerPingPairs: pings.length, matchedPingLabels: matchedPings, contentClockProbes: count('content_clock'),
    structureInventories: count('structure_inventory'),
    failureDiagnosticsAvailable: !!worker.failures && typeof worker.failures === 'object' };
}
function offsetFor(workerPing, desktopPing) {
  if (!finite(workerPing.before) || !finite(workerPing.after) || workerPing.before > workerPing.after
    || !interval(desktopPing.received) || !interval(desktopPing.pongSent)
    || desktopPing.received[1] > desktopPing.pongSent[0]) return null;
  // Desktop minus worker. Full receive/send brackets are retained; no RTT/2.
  const value = [desktopPing.pongSent[0] - workerPing.after, desktopPing.received[1] - workerPing.before];
  return interval(value) ? value : null;
}
function intersect(values) {
  if (!values.length || values.some(v => !interval(v))) return null;
  const result = [Math.max(...values.map(v => v[0])), Math.min(...values.map(v => v[1]))];
  return interval(result) ? result : null;
}
function causalWorkerBracket(endpoint, pairs) {
  if (!interval(endpoint) || !Array.isArray(pairs)) return null;
  const usable = pairs.filter(p => finite(p.before) && finite(p.after) && p.before <= p.after
    && interval(p.received) && interval(p.pongSent) && p.received[1] <= p.pongSent[0]);
  const preceding = usable.filter(p => p.after <= endpoint[0]);
  const following = usable.filter(p => p.before >= endpoint[1]);
  if (!preceding.length || !following.length) return null;
  // Causal bounds on ONE matched physical channel; no RTT/2, offset constancy,
  // or clock-rate equality is assumed. Anonymous correspondence remains a
  // separate assumption and is NOT certified by this arithmetic function.
  const low = Math.max(...preceding.map(p => p.pongSent[0]));
  const high = Math.min(...following.map(p => p.received[1]));
  return low <= high ? [low, high] : null;
}
function bracketTransition(previous, current) {
  if (!previous || !current || !finite(previous.before) || !finite(previous.after)
    || !finite(current.before) || !finite(current.after) || previous.before > previous.after
    || current.before > current.after || current.before < previous.after
    || current.after - previous.before > 250 || current.sameScope !== true
    || !['quiet', 'running'].includes(previous.state)
    || !['quiet', 'running'].includes(current.state)
    || previous.state === current.state) return null;
  // The change may occur anywhere between the previous read's beginning and
  // the current read's end. Positive sample time is never the true onset.
  return [previous.before, current.after];
}
function analyzeNativeMeasurement(worker, desktop, options = {}) {
  const base = { schema: 1, environment: 'native_export_analysis', formalAcceptance: false,
    productFixRequired: null, classification: 'measurement_insufficient', independentScopeVerified: false,
    continuous1sVerified: false, orderProven: false, clocks: [], contentClocks: [], transitions: [], segments: [], causalSegments: [], structureInventories: [],
    missing: ['independent_exact_payload_scope_link', 'uninterrupted_one_second', 'durability_before_ack_order_evidence',
      'independent_t0_and_lease_ready', 'ui_application_endpoint'],
    optionalUnmeasuredEndpoints: ['kernel_ack_send_timestamp'] };
  if (worker?.v !== 1 || worker.environment !== 'native_chrome_capture' || desktop?.schema !== 1
    || !Array.isArray(worker.records) || worker.records.length > MAX_RECORDS
    || !Array.isArray(desktop.events) || desktop.events.length > MAX_RECORDS
    || !Array.isArray(desktop.pings) || desktop.pings.length > MAX_RECORDS) {
    return { ...base, category: 'invalid_export_shape' };
  }
  base.evidence = evidenceSummary(worker, desktop);
  base.channelEvidence = analyzeChannelEvidence(worker.channelEvidence, desktop.channelEvidence);
  base.seriesEvidence = analyzeSeriesEvidence(worker.seriesEvidence, worker.records);
  if (worker.missing === true || worker.disposed === true || desktop.status === 'unknown' || desktop.status === 'disposed')
    base.channelEvidence = { ...base.channelEvidence, status:'unknown', reason:'capture_incomplete' };
  base.preflight = assessNativePreflight(worker, desktop, options.expectedKit, options.previousWorker,
    { requireNewWorkerGeneration: options.requireNewWorkerGeneration });
  base.structureInventories = worker.records.filter(r => r?.kind === 'structure_inventory').map(inventorySummary).filter(Boolean);
  const inventoryReceived = base.evidence.structureInventories;
  const inventoryValid = base.structureInventories.length;
  base.evidence.structureInventories = { received: inventoryReceived, valid: inventoryValid,
    rejected: inventoryReceived - inventoryValid,
    category: inventoryReceived === 0 ? 'not_collected' : inventoryValid === inventoryReceived ? 'available' : 'invalid_records' };
  const wp = worker.records.filter(r => r?.kind === 'ping' && r.recording !== false);
  const clocks = new Map();
  for (const ping of wp) {
    if (!ordinal(ping.connectionOrdinal) || !finite(ping.pingAt)) continue;
    const workerMatches = wp.filter(p => p.pingAt === ping.pingAt);
    const matches = desktop.pings.filter(p => p?.at === ping.pingAt);
    if (workerMatches.length !== 1 || matches.length !== 1 || matches[0].unique !== true
      || matches[0].missing !== false || !ordinal(matches[0].connectionOrdinal)) continue;
    const match = matches[0], offset = offsetFor(ping, match);
    if (!offset) continue;
    const key = `${ping.connectionOrdinal}/${match.connectionOrdinal}`;
    const group = clocks.get(key) || { workerConnection: ping.connectionOrdinal,
      desktopConnection: match.connectionOrdinal, probes: [] };
    group.probes.push({ before: ping.before, after: ping.after, offset, received: match.received, pongSent: match.pongSent }); clocks.set(key, group);
  }
  const groups = [...clocks.values()].filter(group =>
    [...clocks.values()].filter(g => g.workerConnection === group.workerConnection
      || g.desktopConnection === group.desktopConnection).length === 1);
  // A constant offset is an explicit measurement assumption, bounded by probes
  // on both sides of every endpoint. Clock jump/missing probes => unknown.
  if (worker.missing === true || desktop.status === 'unknown') groups.length = 0;
  for (const group of groups) {
    const sent = worker.records.filter(r => r?.kind === 'event_sent' && r.recording === true
      && r.connectionOrdinal === group.workerConnection && ordinal(r.eventOrdinal) && finite(r.before));
    for (const event of sent) {
      if (sent.filter(r => r.eventOrdinal === event.eventOrdinal).length !== 1) continue;
      const matches = desktop.events.filter(r => r?.connectionOrdinal === group.desktopConnection && r.eventOrdinal === event.eventOrdinal);
      if (matches.length !== 1) continue;
      const acks = worker.records.filter(r => r?.kind === 'raw_ack' && r.recording === true
        && r.connectionOrdinal === event.connectionOrdinal && r.eventOrdinal === event.eventOrdinal && finite(r.at));
      const validated = worker.records.filter(r => r?.kind === 'current_ack' && r.recording === true
        && r.connectionOrdinal === event.connectionOrdinal && r.eventOrdinal === event.eventOrdinal && finite(r.at));
      const ackWindow = acks.length === 1 && validated.length === 1 && acks[0].at <= validated[0].at
        ? causalWorkerBracket([acks[0].at, validated[0].at], group.probes) : null;
      base.causalSegments.push({ workerConnection: group.workerConnection, desktopConnection: group.desktopConnection,
        eventOrdinal: event.eventOrdinal, sendHookInDesktopClock: causalWorkerBracket([event.before, event.before], group.probes),
        rawToValidationHookInDesktopClock: ackWindow, category: 'anonymous_channel_causal_bracket_only',
        identityVerified: false, deadlineVerdict: 'unknown', formalAcceptance: false });
    }
  }
  for (const group of groups) {
    const offsets = intersect(group.probes.map(p => p.offset));
    if (!offsets) continue;
    base.clocks.push({ workerConnection: group.workerConnection, desktopConnection: group.desktopConnection,
      probeCount: group.probes.length, offset: offsets, category: 'bounded_offset_assuming_stable_clock' });
    const sent = worker.records.filter(r => r?.kind === 'event_sent' && r.recording !== false && r.connectionOrdinal === group.workerConnection);
    for (const event of sent) {
      if (!ordinal(event.eventOrdinal) || !finite(event.before)) continue;
      const same = sent.filter(e => e.eventOrdinal === event.eventOrdinal);
      const matches = desktop.events.filter(e => e?.connectionOrdinal === group.desktopConnection && e.eventOrdinal === event.eventOrdinal);
      if (same.length !== 1 || matches.length !== 1 || !interval(matches[0].received)) continue;
      const received = matches[0].received;
      const sourceEndpoint = [event.before, event.before];
      const mappedSource = [sourceEndpoint[0] + offsets[0], sourceEndpoint[1] + offsets[1]];
      const low = Math.min(event.before, received[0] - offsets[1]);
      const high = Math.max(event.before, received[1] - offsets[0]);
      const bracketed = group.probes.some(p => p.after <= low) && group.probes.some(p => p.before >= high);
      base.segments.push({ workerConnection: group.workerConnection, desktopConnection: group.desktopConnection,
        eventOrdinal: event.eventOrdinal, category: bracketed ? 'anonymous_ordinal_segment_only' : 'clock_not_bracketed',
        delayMs: bracketed ? [received[0] - mappedSource[1], received[1] - mappedSource[0]] : null,
        identityVerified: false, deadlineVerdict: 'unknown' });
    }
  }
  const contentGroups = new Map();
  for (const p of worker.records.filter(r => r?.kind === 'content_clock' && r.recording !== false)) {
    if (!ordinal(p.tabOrdinal) || !ordinal(p.documentOrdinal) || !finite(p.clockOrigin)
      || ![p.before, p.received, p.sent, p.after].every(finite)
      || p.before > p.after || p.received > p.sent) continue;
    const key = `${p.tabOrdinal}/${p.documentOrdinal}/${p.clockOrigin}`;
    const group = contentGroups.get(key) || { tabOrdinal: p.tabOrdinal, documentOrdinal: p.documentOrdinal,
      clockOrigin: p.clockOrigin, probes: [] };
    const offset = [p.before - p.received, p.after - p.sent];
    group.probes.push({ received: p.received, sent: p.sent, offset }); contentGroups.set(key, group);
  }
  if (worker.missing !== true) for (const group of contentGroups.values()) {
    const offset = intersect(group.probes.map(p => p.offset));
    if (!offset || [...contentGroups.values()].filter(g => g.documentOrdinal === group.documentOrdinal).length !== 1) continue;
    base.contentClocks.push({ tabOrdinal: group.tabOrdinal, documentOrdinal: group.documentOrdinal,
      probeCount: group.probes.length, workerMinusContent: offset, category: 'bounded_offset_assuming_stable_clock' });
  }
  const last = new Map();
  for (const sample of worker.records.filter(r => r?.kind === 'dom' && r.recording !== false)) {
    if (!ordinal(sample.tabOrdinal) || !ordinal(sample.documentOrdinal)) continue;
    const key = `${sample.tabOrdinal}/${sample.documentOrdinal}`;
    const window = bracketTransition(last.get(key), sample);
    if (window) {
      const c = base.contentClocks.find(g => g.documentOrdinal === sample.documentOrdinal && g.tabOrdinal === sample.tabOrdinal);
      const probes = [...contentGroups.values()].find(g => g.documentOrdinal === sample.documentOrdinal && g.tabOrdinal === sample.tabOrdinal)?.probes || [];
      const bracketed = probes.some(p => p.sent <= window[0]) && probes.some(p => p.received >= window[1]);
      const workerWindow = c ? [window[0] + c.workerMinusContent[0], window[1] + c.workerMinusContent[1]] : null;
      const desktopGroup = base.clocks.length === 1 ? groups.find(g => g.workerConnection === base.clocks[0].workerConnection
        && g.desktopConnection === base.clocks[0].desktopConnection) : null;
      const desktopBracketed = workerWindow && desktopGroup
        && desktopGroup.probes.some(p => p.after <= workerWindow[0])
        && desktopGroup.probes.some(p => p.before >= workerWindow[1]);
      const desktopOffset = base.clocks.length === 1 && c && bracketed && desktopBracketed
        ? [base.clocks[0].offset[0] + c.workerMinusContent[0], base.clocks[0].offset[1] + c.workerMinusContent[1]] : null;
      base.transitions.push({ tabOrdinal: sample.tabOrdinal, documentOrdinal: sample.documentOrdinal,
        state: sample.state, contentClockWindow: window,
        desktopClockWindow: desktopOffset ? [window[0] + desktopOffset[0], window[1] + desktopOffset[1]] : null,
        continuous1sVerified: false, linkedEventVerified: false, deadlineVerdict: 'unknown' });
    }
    last.set(key, sample);
  }
  return { ...base, category: base.clocks.length ? 'partial_native_timing_available' : 'clock_mapping_unavailable' };
}
function readExport(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error('invalid_export_file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
module.exports = { analyzeNativeMeasurement, offsetFor, bracketTransition, ackCoverage, causalWorkerBracket };
if (require.main === module) {
  try {
    if (![4, 5].includes(process.argv.length)) throw new Error('invalid_arguments');
    process.stdout.write(JSON.stringify(analyzeNativeMeasurement(readExport(process.argv[2]), readExport(process.argv[3]),
      { expectedKit: process.argv[4] ? readExport(process.argv[4]) : null }), null, 2) + '\n');
  } catch (_) { process.stderr.write('Native exports could not be analyzed. No product verdict was made.\n'); process.exitCode = 1; }
}
