/* SPDX-License-Identifier: AGPL-3.0-only */
// Source-overlay installations have no generated build identity. Keep that
// metadata unknown without preventing the actual extension from starting.
try { importScripts('build-info.js'); }
catch (_) { globalThis.MoriBrowserBuildInfo = null; }
// Product imports are mandatory: a missing/broken module must still fail.
importScripts('monitoring-contract.js', 'provider-utils.js', 'restart-health.js', 'session-coordinator.js', 'outbox.js', 'transport.js', 'observer-recovery.js', 'operation-queue.js');

'use strict';
// A development compiler replaces this exact null binding in a separate VM
// closure. The packaged worker has no setting/message/global to enable it.
const measurement = null; // MORI_MEASUREMENT_SINK
function measure(stage, fields = {}) { try { measurement?.record(stage, fields); } catch (_) {} }
function measurementFailure() { try { measurement?.seriesFailure?.('missing_hook'); } catch (_) {} }
const measurementReferences = measurement ? new WeakMap() : null;
function measurementReference(value) {
  if (!measurementReferences || !value || !['object','function'].includes(typeof value)) return null;
  if (!measurementReferences.has(value)) measurementReferences.set(value, Object.freeze({}));
  return measurementReferences.get(value);
}
function measurementProjection(value, keys, metadata = false) {
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==null&&prototype!==Object.prototype)return null;
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  const allowed=metadata?[...keys,'conversationTitle','requestPreview']:keys;
  if(keys.some(key=>!Object.hasOwn(descriptors,key))||names.some(key=>typeof key!=='string'||!allowed.includes(key)||!Object.hasOwn(descriptors[key],'value')))return null;
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
function measurementSample(value) {
  return measurementProjection(value, ['type','v','pageInstanceId','contentSequence','observedAt','status','generationToken',
    'outcome','workerEpoch','leaseId','bindingEpoch','scopeKind','viewEpoch','samplingEpoch','startUnobserved'], true);
}
function measurementScope(value) {
  return measurementProjection(value, ['kind','viewEpoch','bindingEpoch','samplingEpoch','workerEpoch','leaseId','documentId','startUnobserved']);
}
function measurementEvent(value) {
  const event = measurementProjection(value, ['type','v','schema','eventId','browserRunId','sessionId','sequence','kind','provider',
    'tabId','pageInstanceId','routeRevision','conversationRef','turnId','generation','phase','outcome','observation','observedAt','replay','scope','gap'], true);
  if(!event)return null;
  event.scope = measurementScope(event.scope);
  if(event.gap!==null){event.gap=measurementProjection(event.gap,['turnId','reason','observedAt']);if(!event.gap)return null;}
  return event.scope ? event : null;
}
function measurementSender(sender) {
  if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)
    || sender.tab.id < 0 || typeof sender.documentId !== 'string') return null;
  const url = new URL(sender.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['chatgpt.com','claude.ai'].includes(url.hostname)
    || sender.documentLifecycle && sender.documentLifecycle !== 'active') return null;
  return { tabId: sender.tab.id, documentId: sender.documentId, provider: url.hostname === 'chatgpt.com' ? 'chatgpt' : 'claude',
    frameId: 0, lifecycle: sender.documentLifecycle === 'active' ? 'active' : 'unknown' };
}
try { measurement?.setReferenceProvider?.(measurementReference); } catch (_) { measurementFailure(); }
const utils = MoriProviderUtils;
const coordinator = MoriSessionCoordinator;
const monitoring = MoriMonitoringContract;
let clientId;
let credential = null;
let settings = { enabled: true };
let sessions;
let outbox = { v: 1, events: [] };
let transport;
let observationNegotiation = null;
let fatalError = null;
let desktopFault = null;
let diagnostic = null;
let connectionStatus = { state: 'loading', code: null };
let queue = Promise.resolve();
const operationQueue = MoriOperationQueue.createQueue();
const observationSignatures = new Map();
let optionsQueue = Promise.resolve();
let controlGeneration = 0;
let pendingControls = 0;
// Private development capture only: no settings/message/global enables this.
try { measurement?.setWorkerStateReader?.(() => ({ initialized: !!sessions, paired: !!credential,
  enabled: settings.enabled === true, pendingControl: pendingControls > 0, fatal: !!fatalError,
  transportReady: transport?.isReady() === true })); } catch (_) {}
let pairingGeneration = null;
let flushing = null;
let healthProviders = MoriRestartHealth.unknownProviders();
let healthProvidersAt = 0;
let healthSequence = 0;
let healthRevision = 0;
let refreshOwner = null;
let replayReceiptKeys = null;
let migrationBackupWritten = false;
// Registration is deliberately not restored from storage.session. A new
// worker must verify the current observer again without resetting its timer
// or generation controller merely because this grant epoch changed.
const workerEpoch = crypto.randomUUID();
const observerLeases = new Map();
const recoveryAttempts = new Map();
const completedRegistrations = new Map();
const provisionalCandidates = new Map();
const provisionalObservers = new Map();
const pendingRegistrations = new Map();
// A lifecycle notification can arrive while Chrome delivers a final snapshot.
// Keep only in-flight registrations here; never grow a history of visited tabs.
const registrationFences = new Set();
function invalidateRegistrations(tabId) {
  for (const fence of registrationFences) if (fence.tabId === tabId) fence.invalidated = true;
}
const freshEvents = new Map();
const liveReceipts = new Set();
const savedProofs = new Map();
const revokedProofs = new Map();
const deliveryFailures = new Map();
let healthInventory = null;
const eventKey = event => `${event.browserRunId}/${event.sessionId}/${event.eventId}`;
const observerRecovery = MoriObserverRecovery.createRecovery({ chrome, within,
  getBlockReason: admissionBlockReason, beginAttempt: beginRecoveryAttempt,
  endAttempt: endRecoveryAttempt, completeAttempt: id => endRecoveryAttempt(id, { retainLease: true }),
  waitForRegistration: tabId => pendingRegistrations.get(tabId), isAdmitted: admittedIdentity });

function admissionBlockReason() {
  return fatalError || (pendingControls || !settings.enabled ? 'paused' : !credential ? 'unpaired' : null);
}

function beginRecoveryAttempt(target) {
  if (admissionBlockReason()) return null;
  completedRegistrations.delete(target.tabId);
  for (const [id, attempt] of recoveryAttempts) {
    if (attempt.expiresAt <= Date.now() || attempt.tabId === target.tabId) endRecoveryAttempt(id);
  }
  if (recoveryAttempts.size >= coordinator.MAX_TABS) return null;
  const attemptId = crypto.randomUUID();
  recoveryAttempts.set(attemptId, { ...target, generation: controlGeneration });
  return attemptId;
}

function endRecoveryAttempt(attemptId, { retainLease = false, retainObserver = false } = {}) {
  const attempt = recoveryAttempts.get(attemptId);
  if (!attempt) return false;
  const lease = attempt && observerLeases.get(attempt.tabId);
  let retained = false;
  const candidate = provisionalCandidates.get(attemptId);
  if (retainObserver && candidate && attempt.expiresAt > Date.now() && !admissionBlockReason()
    && attempt.generation === controlGeneration && candidate.generation === controlGeneration
    && candidate.documentId === attempt.documentId && candidate.tabId === attempt.tabId
    && (provisionalObservers.size < coordinator.MAX_TABS || provisionalObservers.has(attempt.tabId))) {
    provisionalObservers.set(attempt.tabId, candidate);
    retained = true; // Observer ownership only: no lease, proof or recovered count.
  }
  if (retainLease && attempt && attempt.expiresAt > Date.now() && !admissionBlockReason()
    && attempt.generation === controlGeneration && lease?.generation === controlGeneration
    && lease.attemptId === attemptId && lease.documentId === attempt.documentId
    && (!attempt.pageInstanceId || lease.pageInstanceId === attempt.pageInstanceId)) {
    for (const [tabId, grant] of completedRegistrations) {
      const current = observerLeases.get(tabId);
      if (!current || current.documentId !== grant.documentId || current.generation !== grant.generation) completedRegistrations.delete(tabId);
    }
    if (completedRegistrations.size < coordinator.MAX_TABS || completedRegistrations.has(attempt.tabId)) {
      completedRegistrations.set(attempt.tabId, { attemptId, documentId: attempt.documentId, generation: attempt.generation });
      retained = true;
    }
  }
  recoveryAttempts.delete(attemptId);
  provisionalCandidates.delete(attemptId);
  if (!retained) for (const [tabId, lease] of observerLeases) {
    if (lease.attemptId === attemptId) observerLeases.delete(tabId);
  }
  return retained;
}

function validAttempt(attemptId, sender, pageInstanceId, route, generation) {
  if (attemptId === null) return true; // the manifest's initial start
  const completed = completedRegistrations.get(sender.tab.id);
  if (completed?.attemptId === attemptId && completed.documentId === sender.documentId && completed.generation === generation) return true;
  const provisional = provisionalObservers.get(sender.tab.id);
  if (provisional?.attemptId === attemptId && provisional.documentId === sender.documentId && provisional.generation === generation) return true;
  const attempt = recoveryAttempts.get(attemptId);
  return !!attempt && attempt.expiresAt > Date.now() && attempt.generation === generation
    && attempt.tabId === sender.tab.id && attempt.documentId === sender.documentId
    && (!attempt.pageInstanceId || attempt.pageInstanceId === pageInstanceId)
    && (route === null || utils.sameRoute(route, attempt.route));
}

function leaseFieldsMatch(a, b) {
  return !!a && !!b && a.workerEpoch === b.workerEpoch && a.leaseId === b.leaseId
    && a.bindingEpoch === b.bindingEpoch;
}

function admittedIdentity({ tabId, documentId, route, identity }) {
  const lease = observerLeases.get(tabId);
  return !admissionBlockReason() && !!lease && lease.generation === controlGeneration
    && (!documentId || lease.documentId === documentId) && lease.pageInstanceId === identity?.pageInstanceId
    && identity.binding.state === 'confirmed' && identity.binding.epoch === lease.bindingEpoch
    && utils.sameRoute(route, lease.route) && utils.sameRoute(route, identity.route)
    && leaseFieldsMatch(lease, identity.lease);
}

function stopAdmission() {
  pendingControls++;
  controlGeneration++;
  observationNegotiation = null;
  observerLeases.clear();
  observationSignatures.clear();
  savedProofs.clear();
  recoveryAttempts.clear();
  completedRegistrations.clear();
  provisionalCandidates.clear(); provisionalObservers.clear();
  observerRecovery.invalidateAll();
  invalidateHealth();
  transport?.setEnabled(false);
}

function resumeAdmission() {
  pendingControls--;
  if (!pendingControls && !fatalError) {
    const ready = transport?.isReady();
    transport?.setEnabled(settings.enabled);
    if (!credential) connectionStatus = { state: 'unpaired', code: null };
    if (ready && settings.enabled && credential) void transportReady();
    else if (settings.enabled && credential) void requestFreshObservations();
  }
}

function enqueue(operation, options) {
  const result = operationQueue.enqueue(operation, options);
  queue = operationQueue.whenIdle();
  return result;
}

function failStorage(code = 'storage_failed') {
  fatalError = code;
  observationNegotiation = null;
  observerLeases.clear();
  savedProofs.clear();
  recoveryAttempts.clear();
  completedRegistrations.clear();
  provisionalCandidates.clear(); provisionalObservers.clear();
  observerRecovery.invalidateAll();
  invalidateHealth();
  transport?.setEnabled(false);
  connectionStatus = { state: 'error', code };
}

function safeCredential(value) {
  if (!value || value.clientId !== clientId || !utils.ID.test(value.instanceId || '')
    || !MoriTransport.PORTS.includes(value.port)) throw new Error('local_data_invalid');
  try { MoriTransport.fromBase64url(value.key, 32); }
  catch (_) { throw new Error('local_data_invalid'); }
  return { clientId, instanceId: value.instanceId, port: value.port, key: value.key };
}

async function requiredStorage(operation) {
  try { return await operation(); }
  catch (_) { failStorage(); throw new Error('storage_failed'); }
}

async function initialize() {
  // Access levels are established before reading or writing any credential.
  await requiredStorage(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
  await requiredStorage(() => chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }));
  const local = await requiredStorage(() => chrome.storage.local.get(['moriClientId', 'moriCredential', 'moriSettings', 'moriOutbox', 'moriMonitoringPreV2']));
  if (!local.moriClientId && (local.moriCredential || local.moriOutbox?.events?.length)) throw new Error('local_data_invalid');
  clientId = local.moriClientId || crypto.randomUUID();
  if (!utils.ID.test(clientId)) throw new Error('local_data_invalid');
  if (!local.moriClientId) await requiredStorage(() => chrome.storage.local.set({ moriClientId: clientId }));
  if (local.moriCredential) credential = safeCredential(local.moriCredential);
  if (local.moriSettings) {
    if (typeof local.moriSettings.enabled !== 'boolean') throw new Error('local_data_invalid');
    settings = { enabled: local.moriSettings.enabled };
  }
  if (local.moriOutbox) {
    if (!MoriOutbox.valid(local.moriOutbox)) throw new Error('local_data_invalid');
    outbox = local.moriOutbox;
  }
  if (local.moriMonitoringPreV2) {
    const backup = local.moriMonitoringPreV2;
    if (backup.v !== 2 || !coordinator.validState(backup.sessions) || !MoriOutbox.valid(backup.outbox)) throw new Error('local_data_invalid');
    migrationBackupWritten = true;
  }
  const saved = await requiredStorage(() => chrome.storage.session.get('moriSessions'));
  sessions = saved.moriSessions || coordinator.newState(crypto.randomUUID());
  if (!coordinator.validState(sessions)) throw new Error('local_data_invalid');
  const recovered = coordinator.recoverDurableEvents(sessions, outbox.events);
  if (!saved.moriSessions || recovered !== sessions) {
    await requiredStorage(() => chrome.storage.session.set({ moriSessions: recovered }));
  }
  sessions = recovered;
  transport = new MoriTransport.Transport({
    clientId, browserRunId: sessions.browserRunId,
    getCredential: () => credential,
    saveCredential: async value => {
      const next = safeCredential(value);
      const generation = controlGeneration;
      await enqueue(async () => {
        if (fatalError || generation !== controlGeneration
          || (pendingControls && pairingGeneration !== generation)
          || (!credential && pairingGeneration !== generation)) throw new Error('attempt_expired');
        await requiredStorage(() => chrome.storage.local.set({ moriCredential: next }));
        credential = next;
      });
    },
    onStatus: status => {
      if (status.state !== 'connected') { liveReceipts.clear(); savedProofs.clear(); invalidateHealth(); }
      if (!fatalError) connectionStatus = status;
    },
    onReady: transportReady,
    onHeartbeat: () => { publishHealth(); return requestFreshObservations(); },
    onFocus: focusRequest,
    measurement,
    measurementReferenceFor: measurement ? measurementReference : null,
  });
  transport.setEnabled(settings.enabled && !pendingControls);
}

async function transportReady() {
  if (transport?.isReady() && credential && !admissionBlockReason()) {
    measure('authenticated_ready');
    observationNegotiation = { credential, generation: controlGeneration,
      scope: !!transport.getPeerInfo?.()?.capabilities.includes(monitoring.CAPABILITIES[0]),
      view: !!transport.getPeerInfo?.()?.capabilities.includes(monitoring.CAPABILITIES[1]) };
  }
  // Never wait for page queries, registration, the mutation queue or receipt
  // replay before reporting the current (possibly unknown) inventory.
  if (!replayReceiptKeys) replayReceiptKeys = new Set(outbox.events.map(eventKey));
  publishHealth();
  const generation = controlGeneration;
  await enqueue(async () => {
    if (generation === controlGeneration && !admissionBlockReason()) await commit(coordinator.snapshot(sessions));
  });
  if (generation !== controlGeneration || admissionBlockReason()) return;
  void flush();
  await requestFreshObservations();
}

function observationCapabilities() {
  if (transport?.isReady()) return {
    scope: !!transport.getPeerInfo?.()?.capabilities.includes(monitoring.CAPABILITIES[0]),
    view: !!transport.getPeerInfo?.()?.capabilities.includes(monitoring.CAPABILITIES[1]),
  };
  // A temporary disconnect is not negotiation of a legacy observation format.
  // This cache governs local observation/journalling only. Wire delivery still
  // requires the live authenticated peer's capabilities in flush().
  return observationNegotiation?.credential === credential
    && observationNegotiation.generation === controlGeneration ? observationNegotiation : null;
}

function invalidateHealth() {
  healthRevision++;
  healthProviders = MoriRestartHealth.unknownProviders();
  healthProvidersAt = 0;
  healthInventory = null;
  for (const tabId of [...savedProofs.keys()]) revokeProof(tabId);
  publishHealth();
}

function revokeProof(tabId) {
  const saved = savedProofs.get(tabId);
  if (saved) {
    if (revokedProofs.size >= 20 && !revokedProofs.has(tabId)) {
      transport?.disconnect('scope_invalidation'); revokedProofs.clear(); savedProofs.clear(); return;
    }
    revokedProofs.set(tabId, { proof: saved.proof, at: performance.now() }); savedProofs.delete(tabId);
  }
}

function currentHealthProviders() {
  const inventoryAge = Date.now() - healthProvidersAt;
  if (!healthProvidersAt || inventoryAge < 0 || inventoryAge > 45000) return MoriRestartHealth.unknownProviders();
  if (transport?.getPeerInfo?.()?.capabilities.includes(monitoring.CAPABILITIES[2]) && healthInventory) {
    const results = new Map(healthInventory.results);
    for (const [tabId, reason] of deliveryFailures) if (results.has(tabId)) results.set(tabId, { ...results.get(tabId), reason });
    return MoriRestartHealth.summarizeV2(healthInventory.tabs, results, {
      enabled: settings.enabled, access: healthInventory.access, evidence: currentProofs(),
      context: { connected: transport.isReady(), paired: !!credential, fault: fatalError || desktopFault } });
  }
  const age = Date.now() - healthProvidersAt;
  return healthProvidersAt > 0 && age >= 0 && age <= 45000
    ? healthProviders : MoriRestartHealth.unknownProviders();
}

function currentProofs() {
  const active = new Map();
  for (const [tabId, saved] of savedProofs) {
    const record = sessions?.sessions[sessions.tabs[tabId]], lease = observerLeases.get(tabId);
    const age = Date.now() - saved.event.observedAt, elapsed = performance.now() - saved.receivedMono;
    if (!record || !lease || desktopFault || !transport?.isReady() || record.observation !== 'fresh'
      || saved.connection !== transport.connection || age < 0 || age >= monitoring.PROOF_MS
      || elapsed < 0 || elapsed >= monitoring.PROOF_MS || Date.now() - record.lastObservationAt > monitoring.MAX_SAMPLE_GAP_MS
      || lease.pageInstanceId !== saved.event.pageInstanceId || !leaseFieldsMatch(lease, saved.event.scope)
      || monitoring.scopeOwnerKey(record.scope) !== monitoring.scopeOwnerKey(saved.event.scope)) {
      revokeProof(tabId); continue;
    }
    active.set(tabId, saved);
  }
  return active;
}

function recordProof(event, ack, owner) {
  let measuredAckGate = null, measuredAckSubject = null;
  // Read-only diagnostic. None of these comparisons decide product admission
  // or mutate proof state; a missing/throwing sink cannot change the ACK path.
  if (measurement && event.type === 'scope.event') {
    try {
      const projected = measurementEvent(event);
      if (!projected) throw new Error('measurement_projection');
      measuredAckSubject = Object.fromEntries([
        'browserRunId', 'sessionId', 'eventId', 'sequence', 'tabId', 'pageInstanceId',
        'routeRevision', 'turnId', 'generation', 'kind', 'scope',
      ].map(key => [key, projected[key]]));
      const lease = observerLeases.get(event.tabId), record = sessions?.sessions[sessions.tabs[event.tabId]];
      const age = Date.now() - event.observedAt, sampleAge = Date.now() - record?.lastObservationAt;
      const gate = owner.generation !== controlGeneration ? 'control_generation_changed'
        : owner.credential !== credential ? 'credential_changed'
        : !ack.proof ? 'proof_absent' : ack.disposition !== 'committed_current' ? 'disposition_not_current'
        : event.replay ? 'replay' : !currentEvent(event) ? 'session_not_current'
        : !transport?.isReady() ? 'transport_not_ready' : owner.connection !== transport.connection ? 'connection_changed'
        : !lease ? 'lease_missing' : lease.generation !== controlGeneration ? 'lease_generation_changed'
        : lease.pageInstanceId !== event.pageInstanceId ? 'page_changed'
        : lease.documentId !== event.scope.documentId ? 'document_changed'
        : !leaseFieldsMatch(lease, event.scope) ? 'lease_scope_changed'
        : record?.observation !== 'fresh' ? 'observation_not_fresh' : record.sequence !== event.sequence ? 'sequence_changed'
        : !Number.isFinite(age) || age < 0 ? 'event_time_invalid' : age >= monitoring.PROOF_MS ? 'event_expired'
        : !Number.isFinite(sampleAge) || sampleAge < 0 ? 'sample_time_invalid'
        : sampleAge > monitoring.MAX_SAMPLE_GAP_MS ? 'sample_expired' : 'accepted_current';
      measuredAckGate = gate;
      measurement.ackDecision?.(measuredAckSubject,
      { gate, proofPresent: !!ack.proof, replay: event.replay === true, sameConnection: owner.connection === transport?.connection });
    } catch (_) { measurementFailure(); }
  }
  if (measurement) {
    try {
      const consumed = transport?.measurementAckConsumed?.(ack, event, owner.connection);
      if (consumed) measurement.validationComplete?.({ ...consumed, gate: measuredAckGate || 'unclassified',
        at: performance.timeOrigin + performance.now() });
      else measurement.seriesFailure?.('proof_unavailable');
    } catch (_) { try { measurement.seriesFailure?.('proof_unavailable'); } catch (_) {} }
  }
  if (event.type !== 'scope.event' || owner.generation !== controlGeneration || owner.credential !== credential) return;
  if (['committed_current', 'committed_receipt'].includes(ack.disposition)) {
    desktopFault = null;
    if (diagnostic === 'desktop_storage_failed') diagnostic = null;
  }
  if (ack.reason) { deliveryFailures.set(event.tabId, ack.reason); if (currentEvent(event)) revokeProof(event.tabId); }
  else deliveryFailures.delete(event.tabId);
  if (!ack.proof || ack.disposition !== 'committed_current' || event.replay) return;
  savedProofs.set(event.tabId, { proof: ack.proof, event, connection: transport.connection, receivedMono: performance.now() });
  // Comparison only. Do not call currentProofs(), which revokes stale state.
  if (measurement) {
    // Share the single diagnostic snapshot, avoiding classification/current
    // disagreement solely because the injected sink advanced the clock.
    if (measuredAckGate === 'accepted_current') {
      measure('ack_validated_current');
      try { measurement.currentAck?.(measuredAckSubject,
      { sameConnection: owner.connection === transport.connection }); } catch (_) { measurementFailure(); }
    }
  }
  revokedProofs.delete(event.tabId);
  if (savedProofs.size > coordinator.MAX_TABS) savedProofs.delete(event.tabId);
  publishHealth();
}

function desktopWriteFailed() {
  if (desktopFault === 'storage_failed') return;
  desktopFault = 'storage_failed'; diagnostic = 'desktop_storage_failed';
  for (const tabId of [...savedProofs.keys()]) revokeProof(tabId);
  observerLeases.clear();
  // Retain the connected transport to retry durable writes. Observation needs
  // a new lease/series; no previous proof remains usable during this fault.
  const generation = controlGeneration;
  const targets = Object.entries(sessions.tabs).map(([tabId, id]) => ({ tabId: Number(tabId), id,
    sequence: sessions.sessions[id]?.sequence }));
  for (const target of targets) void enqueue(async () => {
    if (generation !== controlGeneration || fatalError || sessions.tabs[target.tabId] !== target.id
      || sessions.sessions[target.id]?.sequence !== target.sequence) return;
    await commit(coordinator.invalidateTab(sessions, target.tabId));
  }, { key: `tab:${target.tabId}`, priority: true }).catch(reportRecoveryFailure);
  publishHealth();
}

function publishHealth() {
  if (!transport?.isReady() || !sessions || fatalError || pendingControls || !settings.enabled) return;
  const build = globalThis.MoriBrowserBuildInfo;
  const version = chrome.runtime.getManifest().version;
  if (!build || build.extensionVersion !== version || build.observerContract !== 1
    || typeof build.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(build.buildId)
    || !Number.isSafeInteger(healthSequence + 1)) return;
  const remainingReplay = outbox.events.filter(event => replayReceiptKeys?.has(eventKey(event))).length;
  const message = { type: 'client.health', v: 1, schema: 1,
    browserRunId: sessions.browserRunId, workerEpoch, sequence: ++healthSequence,
    extensionVersion: version, observerVersion: version, buildId: build.buildId, observerContract: 1,
    providers: currentHealthProviders(),
    delivery: { state: diagnostic === 'outbox_full' ? 'capacity_blocked' : remainingReplay ? 'syncing' : 'current',
      remainingReplay, livePending: outbox.events.length - remainingReplay + freshEvents.size, reserveUsed: 0 } };
  if (transport.getPeerInfo?.()?.capabilities.includes(monitoring.CAPABILITIES[2])) {
    const held = outbox.events.filter(e => !monitoring.supports(transport.getPeerInfo(), e)).length;
    const known = new Set(message.providers.filter(p => p.inventory === 'known').map(p => p.provider));
    message.schema = 2; message.proofs = [...currentProofs().values()].filter(p => known.has(p.event.provider)).map(p => p.proof);
    for (const [tabId,p] of revokedProofs) if (performance.now() - p.at >= monitoring.PROOF_MS) revokedProofs.delete(tabId);
    message.revokedProofs = [...revokedProofs.values()].map(p => p.proof);
    Object.assign(message.delivery, { sendablePending: outbox.events.length - held,
      unsupportedHeld: held, retryDeferred: deliveryFailures.size, capacityBlocked: diagnostic === 'outbox_full' ? 1 : 0 });
    if (held || deliveryFailures.size) message.delivery.state = 'syncing';
  }
  // Older peers and test transports have no health capability. Missing
  // metadata never changes the authentication or observation path.
  try { if (transport.sendHealth?.(message)) measure('health_published'); } catch (_) {}
}

const initialized = initialize().catch(error => {
  failStorage(['local_data_invalid', 'storage_failed'].includes(error?.message) ? error.message : 'initialization_failed');
});

// Only storage/authentication readiness gates message handling. Browser probes
// can be slow, unavailable, or call back into this worker during registration.
// They must never become a dependency of that registration's initialization.
void initialized.then(() => {
  if (fatalError) return;
  void ensureReconnectAlarm();
  void reconcileTabs().catch(reportRecoveryFailure);
});

function reportRecoveryFailure(error) {
  if (!fatalError) diagnostic = error?.code === 'observer_queue_full' ? 'observer_queue_full' : 'recovery_failed';
}

async function ensureReconnectAlarm() {
  try {
    await within(Promise.resolve().then(() => chrome.alarms.create('mori-reconnect', { periodInMinutes: 0.5 })));
    if (diagnostic === 'alarm_failed') diagnostic = null;
  } catch (_) { if (!fatalError) diagnostic = 'alarm_failed'; }
}

async function commit(result) {
  if (fatalError) throw new Error(fatalError);
  const measuredCommit = measurement ? Object.freeze({}) : null;
  try { measurement?.commitBegin?.(measurementReference(result), measuredCommit); } catch (_) { measurementFailure(); }
  const critical = result.events.filter(event => ['terminal', 'closed', 'gap'].includes(event.kind));
  let nextOutbox;
  try { nextOutbox = MoriOutbox.append(outbox, critical, measurement ? {
    clone(source, target, kind) {
      try { measurement.queueClone?.(measurementReference(source), measurementReference(target),
        measurementEvent(source), measurementEvent(target), kind); } catch (_) { measurementFailure(); }
    },
  } : undefined); }
  catch (error) {
    diagnostic = error.message;
    throw error;
  }
  try {
    if (!migrationBackupWritten && (result.state.v === 2 || nextOutbox.v === 2)) {
      await chrome.storage.local.set({ moriMonitoringPreV2: { v: 2, sessions, outbox } });
      migrationBackupWritten = true;
    }
    if (critical.length) {
      // Durable terminal metadata is written before the session state and wire.
      await chrome.storage.local.set({ moriOutbox: nextOutbox });
      outbox = nextOutbox;
    }
    await chrome.storage.session.set({ moriSessions: result.state });
    sessions = result.state;
    measure('worker_committed', { count: result.events.length });
  } catch (_) {
    try { measurement?.commitFailed?.(measuredCommit); } catch (_) { measurementFailure(); }
    failStorage(); throw new Error('storage_failed');
  }
  if (result.diagnostic && !['duplicate_observation', 'old_observation'].includes(result.diagnostic)) diagnostic = result.diagnostic;
  if (diagnostic === 'unsupported' && !Object.values(sessions.sessions).some(record => !record.closed && record.observation === 'unsupported')) diagnostic = null;
  if (diagnostic === 'capacity' && Object.keys(sessions.tabs).length < coordinator.MAX_TABS
    && Object.keys(sessions.sessions).length < coordinator.MAX_RECORDS) diagnostic = null;
  for (const event of result.events) {
    const key = `${event.browserRunId}/${event.sessionId}`;
    if (['terminal', 'closed', 'gap'].includes(event.kind)) {
      if (transport?.isReady()) liveReceipts.add(eventKey(event));
      const pending = freshEvents.get(key);
      if (pending && pending.sequence <= event.sequence) freshEvents.delete(key);
      if (measurement) {
        const queued = outbox.events.find(item => item.eventId === event.eventId && item.sessionId === event.sessionId && item.browserRunId === event.browserRunId);
        try { if (queued) measurement.queueAccepted?.(measuredCommit, measurementReference(queued), measurementEvent(queued), 'outbox'); } catch (_) { measurementFailure(); }
      }
    } else {
      if (measurement) {
        const previous = freshEvents.get(key);
        try { if (previous) measurement.queueSuperseded?.(measurementReference(previous)); } catch (_) { measurementFailure(); }
      }
      freshEvents.set(key, event);
      try { measurement?.queueAccepted?.(measuredCommit, measurementReference(event), measurementEvent(event), 'fresh'); } catch (_) { measurementFailure(); }
    }
  }
  publishHealth();
  void flush();
}

function currentEvent(event) {
  if (event.type !== 'scope.event') return true;
  const record = sessions?.sessions[sessions.tabs[event.tabId]];
  return record?.sessionId === event.sessionId && !record.closed
    && monitoring.scopeOwnerKey(record.scope) === monitoring.scopeOwnerKey(event.scope);
}

async function flush() {
  if (flushing?.generation === controlGeneration || admissionBlockReason() || !transport?.isReady()) return;
  const owner = { generation: controlGeneration, credential };
  flushing = owner;
  const blocked = new Set();
  let liveBudget = 10;
  let preferFresh = false;
  try {
    while (transport.isReady() && !admissionBlockReason() && owner.generation === controlGeneration
      && owner.credential === credential) {
      // Always finish durable receipts before publishing current snapshots.
      const eligibleFresh = [...freshEvents.entries()].find(([,e]) => monitoring.supports(transport.getPeerInfo?.(), e)
        && !blocked.has(`${e.type}/${e.browserRunId}/${e.sessionId}`)
        && !outbox.events.some(r => r.browserRunId === e.browserRunId && r.sessionId === e.sessionId));
      const liveCritical = monitoring.selectDeliverable(outbox.events, transport.getPeerInfo?.(), blocked,
        e => liveReceipts.has(eventKey(e)));
      const historical = monitoring.selectDeliverable(outbox.events, transport.getPeerInfo?.(), blocked,
        e => !liveReceipts.has(eventKey(e)));
      let receipt = monitoring.selectDeliverable(outbox.events, transport.getPeerInfo?.(), blocked);
      if (liveBudget <= 0 && historical) receipt = historical;
      else if (eligibleFresh && (preferFresh || !liveCritical)) { receipt = null; preferFresh = false; }
      else if (liveCritical) { receipt = liveCritical; preferFresh = true; }
      if (receipt) {
        const live = liveReceipts.has(eventKey(receipt)) && currentEvent(receipt)
          && receipt.browserRunId === sessions.browserRunId && Date.now() - receipt.observedAt <= 30000;
        const outgoing = { ...receipt, replay: !live };
        try { measurement?.outgoingClone?.(measurementReference(receipt), measurementReference(outgoing),
          measurementEvent(receipt), measurementEvent(outgoing), 'receipt_replay'); } catch (_) { measurementFailure(); }
        let ack;
        const measuredConnection = transport.connection;
        try { ack = await transport.sendEvent(outgoing); }
        catch (error) {
          if (!['session_limit', 'receipt_limit', 'active_session_limit', 'session_store_write_failed'].includes(error.code)) throw error;
          if (error.code === 'session_store_write_failed') desktopWriteFailed();
          blocked.add(`${receipt.type}/${receipt.browserRunId}/${receipt.sessionId}`);
          deliveryFailures.set(receipt.tabId, error.code === 'session_store_write_failed' ? 'storage_failed' : error.code);
          if (currentEvent(receipt)) revokeProof(receipt.tabId);
          publishHealth();
          continue;
        }
        recordProof(outgoing, ack, { ...owner, connection: measuredConnection });
        liveBudget = live ? liveBudget - 1 : 10;
        await enqueue(async () => {
          // A late ACK from a previous pairing or control generation must not
          // recreate or remove data after unpair/pause has linearized.
          if (owner.generation !== controlGeneration || owner.credential !== credential || admissionBlockReason()) return;
          const next = MoriOutbox.acknowledge(outbox, ack);
          const nextSessions = coordinator.removeAcknowledgedClosed(sessions, receipt);
          if (nextSessions !== sessions) {
            await chrome.storage.session.set({ moriSessions: nextSessions });
            sessions = nextSessions;
          }
          // Remove the journal last. A failed write can safely replay an ACKed
          // receipt, whereas removing it before cleanup loses recovery evidence.
          await chrome.storage.local.set({ moriOutbox: next });
          outbox = next;
          liveReceipts.delete(eventKey(receipt));
          if (diagnostic === 'outbox_full' && outbox.events.length < MoriOutbox.MAX_EVENTS) diagnostic = null;
          if (diagnostic === 'observer_queue_full') diagnostic = null;
          publishHealth();
        }).catch(error => {
          // Admission pressure did not attempt a storage write. Keep the
          // durable journal for the next flush instead of latching a false
          // storage fault and stopping the transport permanently.
          if (error?.code === 'observer_queue_full') {
            diagnostic = 'observer_queue_full'; publishHealth(); throw error;
          }
          failStorage(); throw new Error('storage_failed');
        });
        continue;
      }
      const pending = eligibleFresh;
      if (!pending) break;
      const [key, event] = pending;
      // A queued observation may have aged while the desktop was offline.
      const aged = Date.now() - event.observedAt > 30000 || !currentEvent(event);
      const outgoing = aged ? { ...event, replay: true, observation: 'stale' } : event;
      try { measurement?.outgoingClone?.(measurementReference(event), measurementReference(outgoing),
        measurementEvent(event), measurementEvent(outgoing), aged ? 'fresh_stale' : 'none'); } catch (_) { measurementFailure(); }
      let ack;
      const measuredConnection = transport.connection;
      try { ack = await transport.sendEvent(outgoing); }
      catch (error) {
        if (!['session_limit', 'receipt_limit', 'active_session_limit', 'session_store_write_failed'].includes(error.code)) throw error;
        if (error.code === 'session_store_write_failed') desktopWriteFailed();
        blocked.add(`${event.type}/${event.browserRunId}/${event.sessionId}`);
        deliveryFailures.set(event.tabId, error.code === 'session_store_write_failed' ? 'storage_failed' : error.code);
        if (currentEvent(event)) revokeProof(event.tabId);
        publishHealth();
        continue;
      }
      recordProof(outgoing, ack, { ...owner, connection: measuredConnection });
      liveBudget--;
      if (owner.generation === controlGeneration && owner.credential === credential) {
        const latest = freshEvents.get(key);
        freshEvents.delete(key);
        // An update arriving during this ACK wait goes behind other sessions.
        if (latest && latest.eventId !== event.eventId) freshEvents.set(key, latest);
      }
    }
  } catch (_) {
    // The durable outbox remains intact. Connection recovery or the explicit
    // retry button resumes delivery; no terminal event is silently discarded.
  } finally { if (flushing === owner) flushing = null; publishHealth(); }
}

function within(promise, milliseconds = 1500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('tab_unavailable')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function currentObserverIdentity(tabId, pageInstanceId, route) {
  // Bootstrap addresses the active top frame, independently of business focus
  // authorization. An old cached document may still answer a documentId probe.
  const identity = utils.safeObserverIdentity(await within(chrome.tabs.sendMessage(tabId,
    { type: 'mori.observer.identity', pageInstanceId, conversationRef: route.conversationRef }, { frameId: 0 })));
  return identity && identity.pageInstanceId === pageInstanceId && utils.sameRoute(route, identity.route)
    && identity.route.conversationRef === route.conversationRef ? identity : null;
}

function senderProvider(sender) {
  try {
    const url = new URL(sender.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.origin === 'https://chatgpt.com' ? 'chatgpt' : url.origin === 'https://claude.ai' ? 'claude' : null;
  } catch (_) { return null; }
}

function validContentSender(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0
    && Number.isSafeInteger(sender.tab?.id) && sender.tab.id >= 0
    && utils.ID.test(sender.documentId || '')
    && (!sender.documentLifecycle || sender.documentLifecycle === 'active')
    && !!senderProvider(sender);
}

function availableTab(tab, route) {
  return tab && tab.status !== 'loading' && !tab.discarded && !tab.frozen
    && utils.sameRoute(route, utils.routeForUrl(tab.url));
}

async function currentDocumentIdentity(tabId, documentId, route, pageInstanceId) {
  const results = await within(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    world: 'ISOLATED', injectImmediately: true, func: () => {
      const owner = globalThis.__moriBrowserObserverLifecycle;
      return { url: location.origin + location.pathname,
        active: !document.prerendering && document.visibilityState !== 'prerender' && document.readyState !== 'loading',
        identity: owner?.isActive() && typeof owner.identity === 'function' ? { ok: true, v: 1, ...owner.identity() } : null };
    } }));
  const top = results?.length === 1 && results[0];
  if (top?.frameId !== 0 || top.documentId !== documentId || top.result?.active !== true
    || !utils.sameRoute(route, utils.routeForUrl(top.result.url))) return null;
  const identity = utils.safeObserverIdentity(top.result.identity);
  return identity && identity.observerVersion === chrome.runtime.getManifest().version
    && identity.pageInstanceId === pageInstanceId && utils.sameRoute(route, identity.route) ? identity : null;
}

function grantResult(lease) {
  return { ok: true, v: 1, workerEpoch, leaseId: lease.leaseId,
    pageInstanceId: lease.pageInstanceId, bindingEpoch: lease.bindingEpoch, scopeObservation: true };
}

async function registerObserver(input, sender, generation) {
  if (admissionBlockReason() || generation !== controlGeneration) {
    return { ok: false, reason: fatalError || 'paused' };
  }
  const registration = utils.safeObserverRegister(input);
  if (!registration || !validContentSender(sender)) return { ok: false, reason: 'invalid_sender' };
  if (registration.observerVersion !== chrome.runtime.getManifest().version) return { ok: false, reason: 'observer_version' };
  // Reject expired/cancelled owners before any potentially unavailable API.
  // The current route is checked again after Chrome supplies it below.
  if (!validAttempt(registration.attemptId, sender, registration.pageInstanceId, null, generation)) return { ok: false, reason: 'attempt_expired' };
  if (registrationFences.size >= 192) return { ok: false, reason: 'observer_queue_full' };
  const fence = { tabId: sender.tab.id, invalidated: false };
  registrationFences.add(fence);
  return enqueue(async ({ tab, route }) => {
    if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
    if (fence.invalidated) return { ok: false, reason: 'old_document' };
    if (!route || route.provider !== senderProvider(sender) || !availableTab(tab, route)) return { ok: false, reason: 'old_document' };
    if (!validAttempt(registration.attemptId, sender, registration.pageInstanceId, route, generation)) {
      return { ok: false, reason: 'attempt_expired' };
    }
    const identity = await currentDocumentIdentity(tab.id, sender.documentId, route, registration.pageInstanceId);
    if (!identity) return { ok: false, reason: 'old_document' };
    if (fence.invalidated) return { ok: false, reason: 'old_document' };
    if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
    if (!validAttempt(registration.attemptId, sender, registration.pageInstanceId, route, generation)) return { ok: false, reason: 'attempt_expired' };
    if (identity.binding.state !== 'confirmed') {
      const attempt = recoveryAttempts.get(registration.attemptId);
      if (attempt && attempt.expiresAt > Date.now() && attempt.generation === generation) {
        provisionalCandidates.set(registration.attemptId, { attemptId: registration.attemptId,
          tabId: tab.id, documentId: sender.documentId, generation });
      }
      observerLeases.delete(tab.id);
      savedProofs.delete(tab.id);
      if (sessions.tabs[tab.id]) await commit(coordinator.invalidateTab(sessions, tab.id));
      diagnostic = 'binding_unconfirmed';
      return { ok: false, reason: 'binding_unconfirmed' };
    }
    if (identity.binding.kind === 'view' && !observationCapabilities()?.view) return { ok: false, reason: 'peer_unsupported' };
    const existing = observerLeases.get(tab.id);
    if (!existing && observerLeases.size >= coordinator.MAX_TABS) return { ok: false, reason: 'capacity', owner: 'coordinator', resource: 'active_tabs' };
    const sameOwner = existing && existing.generation === generation && existing.documentId === sender.documentId
      && existing.pageInstanceId === registration.pageInstanceId && existing.bindingEpoch === identity.binding.epoch
      && utils.sameRoute(existing.route, route);
    const lease = sameOwner ? existing : { workerEpoch, leaseId: crypto.randomUUID(),
      pageInstanceId: registration.pageInstanceId, bindingEpoch: identity.binding.epoch, tabId: tab.id,
      documentId: sender.documentId, route, generation, attemptId: registration.attemptId };
    lease.attemptId = registration.attemptId;
    observerLeases.set(tab.id, lease);
    // This read-only owner fact only selects development clock-probe targets;
    // it is not independent evidence that a document is currently displayed.
    if(measurement){try{const facts=measurementSender(sender);
      if(!facts)throw new Error('measurement_projection');
      measurement.registeredDocument?.(facts);
    }catch(_){measurementFailure();}}
    if (diagnostic === 'binding_unconfirmed') diagnostic = null;
    return grantResult(lease);
  }, { key: `tab:${sender.tab.id}`, priority: true, prepare: async () => {
    const tab = await within(chrome.tabs.get(sender.tab.id));
    return { tab, route: utils.routeForUrl(tab?.url) };
  } }).finally(() => registrationFences.delete(fence));
}

function observationMessage(input, sender, generation) {
  measure('worker_received');
  if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
  const observation = utils.safeObservation(input);
  if (!observation || !validContentSender(sender)) return { ok: false, reason: 'invalid_sender' };
  const lease = observerLeases.get(sender.tab.id);
  if (!utils.safeLease(observation) || !lease || !leaseFieldsMatch(lease, observation)
    || lease.generation !== generation) return { ok: false, reason: 'lease_invalid' };
  if (lease.pageInstanceId !== observation.pageInstanceId || lease.documentId !== sender.documentId) return { ok: false, reason: 'old_document' };
  const signature = JSON.stringify([observation.pageInstanceId, observation.schema, observation.scopeKind,
    observation.viewEpoch, observation.samplingEpoch, observation.workerEpoch, observation.leaseId,
    observation.bindingEpoch, observation.startUnobserved, observation.status, observation.generationToken, observation.outcome]);
  const priority = observationSignatures.get(sender.tab.id) !== signature;
  observationSignatures.set(sender.tab.id, signature);
  // Reserve this tab's order before Chrome IO starts. Preparation is read-only;
  // later ready events from this tab cannot pass this event's position.
  return enqueue(async ({ tab, route }) => {
  measure('queue_enter');
  if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
  if (observerLeases.get(sender.tab.id) !== lease) return { ok: false, reason: 'lease_expired' };
  if (!route || route.provider !== senderProvider(sender) || !availableTab(tab, route)
    || !utils.sameRoute(route, lease.route)) return { ok: false, reason: 'old_document' };
  // One final script captures both current Chrome document and observer epochs.
  const identity = await currentDocumentIdentity(tab.id, sender.documentId, route, observation.pageInstanceId);
  if (!identity) {
    if (observerLeases.get(tab.id) === lease) {
      savedProofs.delete(tab.id); observerLeases.delete(tab.id);
      if (sessions.tabs[tab.id]) await commit(coordinator.invalidateTab(sessions, tab.id));
    }
    return { ok: false, reason: 'old_document' };
  }
  if (identity.binding.state !== 'confirmed') {
    if (observerLeases.get(tab.id) === lease) {
      savedProofs.delete(tab.id); observerLeases.delete(tab.id);
      if (sessions.tabs[tab.id]) await commit(coordinator.invalidateTab(sessions, tab.id));
    }
    return { ok: false, reason: 'binding_unconfirmed' };
  }
  if (!admittedIdentity({ tabId: tab.id, documentId: sender.documentId, route, identity })) {
    return { ok: false, reason: 'lease_invalid' };
  }
  if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
  if (observerLeases.get(tab.id) !== lease) return { ok: false, reason: 'lease_expired' };
  if (observation.schema === 2 && (identity.samplingEpoch !== observation.samplingEpoch
    || identity.binding.viewEpoch !== observation.viewEpoch || identity.binding.kind !== observation.scopeKind)) {
    savedProofs.delete(tab.id); observerLeases.delete(tab.id);
    if (sessions.tabs[tab.id]) await commit(coordinator.invalidateTab(sessions, tab.id));
    return { ok: false, reason: 'lease_invalid' };
  }
  const capabilities = observationCapabilities();
  if (observation.schema === 2 && !capabilities) return { ok: false, reason: 'ack_unavailable' };
  const scope = observation.schema === 2 && capabilities.scope
    ? { kind: observation.scopeKind, viewEpoch: observation.viewEpoch, samplingEpoch: observation.samplingEpoch,
      ...utils.safeLease(observation), documentId: sender.documentId, startUnobserved: observation.startUnobserved } : null;
  if (observation.scopeKind === 'view' && (!scope || !capabilities.view)) return { ok: false, reason: 'peer_unsupported' };
  // No asynchronous work may be inserted between this final gate and commit.
  // Once the first write starts, a later control waits for this commit to settle.
  let measuredInvocation = null;
  if (measurement && scope) {
    try { const projectedScope=measurementScope(scope);
      if(!projectedScope)throw new Error('measurement_projection');
      measuredInvocation = measurement.reductionBegin?.(measurementReference(input), measurementSample(input),
      { tabId: tab.id, documentId: sender.documentId, scope: projectedScope,
        route: { provider: route.provider, kind: scope.kind, conversationRef: scope.kind === 'view' ? null : route.conversationRef } }); } catch (_) { measurementFailure(); }
  }
  let result;
  try { result = coordinator.reduceObservation(sessions, input,
    { route, tabId: tab.id, documentId: sender.documentId, scope }); }
  catch (error) { try { measurement?.reductionThrow?.(measuredInvocation); } catch (_) { measurementFailure(); } throw error; }
  if (measurement && scope) {
    try { measurement.reductionEnd?.(measuredInvocation, measurementReference(result),
      result.events.map(event => ({ ref: measurementReference(event), event: measurementEvent(event) }))); } catch (_) { measurementFailure(); }
  }
  await commit(result);
  if (measurement && scope) {
    try { const projectedScope=measurementScope(scope),projectedEvents=result.events.map(measurementEvent);
      if(!projectedScope || projectedEvents.some(event=>!event))throw new Error('measurement_projection');
      measurement.linkSample?.({ contentSequence: input.contentSequence, pageInstanceId: input.pageInstanceId,
      generationToken: input.generationToken ?? null }, projectedScope, projectedEvents.map(e => ({
      kind: e.kind, browserRunId: e.browserRunId, sessionId: e.sessionId, eventId: e.eventId,
      sequence: e.sequence, tabId: e.tabId, pageInstanceId: e.pageInstanceId, routeRevision: e.routeRevision,
      turnId: e.turnId, generation: e.generation, scope: e.scope })) ); } catch (_) { measurementFailure(); }
  }
  void transport.ensureConnected();
  if (['invalid_observation', 'old_observation', 'duplicate_observation', 'capacity'].includes(result.diagnostic)) {
    return { ok: false, reason: result.diagnostic, owner: result.owner, resource: result.resource };
  }
  if (healthInventory) healthInventory.results.set(tab.id, { ok: observation.status !== 'unknown',
    reason: deliveryFailures.get(tab.id) || (observation.status === 'unknown' ? 'dom_unknown' : null) });
  publishHealth();
  measure('local_observation_accepted');
  return { ok: true };
  }, { key: `tab:${sender.tab.id}`, priority, prepare: async () => {
    const tab = await within(chrome.tabs.get(sender.tab.id));
    measure('worker_prepared');
    return { tab, route: utils.routeForUrl(tab?.url) };
  } }).catch(error => {
    if (error?.code !== 'observer_queue_full') throw error;
    if (observerLeases.get(sender.tab.id) === lease) {
      revokeProof(sender.tab.id); deliveryFailures.set(sender.tab.id, 'observer_queue_full'); publishHealth();
    }
    return { ok: false, reason: 'observer_queue_full' };
  });
}

async function validateFocus(request, generation) {
  if (admissionBlockReason() || generation !== controlGeneration || !coordinator.focusMatches(sessions, request)) return null;
  const record = sessions.sessions[request.sessionId];
  const lease = observerLeases.get(request.tabId);
  if (!lease || lease.generation !== generation || lease.pageInstanceId !== request.pageInstanceId
    || lease.documentId !== record.documentId || lease.route.conversationRef !== request.conversationRef) return null;
  const tab = await within(chrome.tabs.get(request.tabId));
  const route = utils.routeForUrl(tab.url);
  if (!availableTab(tab, route) || route.provider !== record.provider || !utils.sameRoute(route, lease.route)
    || route.conversationRef !== request.conversationRef) return null;
  const identity = await currentObserverIdentity(tab.id, request.pageInstanceId, route);
  if (!identity || !admittedIdentity({ tabId: tab.id, route, identity })) return null;
  const focused = await within(chrome.tabs.sendMessage(tab.id, { type: 'mori.focus.check',
    pageInstanceId: request.pageInstanceId, conversationRef: request.conversationRef, ...utils.safeLease(lease) }, { frameId: 0 }));
  if (focused?.ok !== true || focused.pageInstanceId !== request.pageInstanceId
    || focused.conversationRef !== request.conversationRef) return null;
  // The page may compute a valid reply before navigation, while Chrome
  // delivers that reply after its tab URL has changed. onUpdated can lag too.
  const afterReply = await within(chrome.tabs.get(tab.id));
  if (!availableTab(afterReply, route)) return null;
  const expectedUrl = new URL(tab.url);
  const frames = await within(chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
    world: 'ISOLATED', injectImmediately: true, args: [expectedUrl.origin, expectedUrl.pathname],
    func: (origin, pathname) => !document.prerendering && document.visibilityState !== 'prerender'
      && location.origin === origin && location.pathname === pathname }));
  if (frames?.length !== 1 || frames[0].frameId !== 0 || frames[0].documentId !== lease.documentId || frames[0].result !== true) return null;
  if (admissionBlockReason() || generation !== controlGeneration || observerLeases.get(tab.id) !== lease
    || !coordinator.focusMatches(sessions, request)) return null;
  return tab;
}

async function focusRequest(request) {
  if (admissionBlockReason() || request.v !== 1) return { ok: false, reason: 'unavailable' };
  const generation = controlGeneration;
  try {
    return await within((async () => {
      const tab = await validateFocus(request, generation);
      if (!tab) return { ok: false, reason: 'session_changed' };
      await chrome.tabs.update(tab.id, { active: true });
      const current = await within(chrome.tabs.get(tab.id));
      await chrome.windows.update(current.windowId, { focused: true });
      // Revalidate again after both focus APIs. A navigation or a new session
      // during focus must leave the captured desktop notice unread.
      if (!(await validateFocus(request, generation))) return { ok: false, reason: 'session_changed' };
      return { ok: true };
    })(), 4000);
  } catch (_) { return { ok: false, reason: 'tab_unavailable' }; }
}

async function requestFreshObservations() {
  if (admissionBlockReason()) return;
  const generation = controlGeneration;
  if (refreshOwner?.generation === generation && refreshOwner.revision === healthRevision) return refreshOwner.promise;
  const owner = { generation, revision: healthRevision, promise: null };
  refreshOwner = owner;
  owner.promise = (async () => {
    const accessPromise = Promise.allSettled(utils.URL_PATTERNS.map(origin => within(Promise.resolve().then(() =>
      chrome.permissions.contains({ origins: [origin] })))));
    const tabs = await queryTabs({ url: utils.URL_PATTERNS });
    if (!tabs || generation !== controlGeneration || admissionBlockReason()) { await accessPromise; return; }
    const candidates = tabs.filter(tab => !!utils.routeForUrl(tab.url));
    const results = new Map(candidates.slice(coordinator.MAX_TABS).map(tab => [tab.id, { overLimit: true }]));
    await Promise.allSettled(candidates.slice(0, coordinator.MAX_TABS).map(async tab => {
      results.set(tab.id, await observerRecovery.ensure(tab));
    }));
    const accessResults = await accessPromise;
    if (owner.revision !== healthRevision || generation !== controlGeneration || admissionBlockReason()) return;
    const access = Object.fromEntries(MoriRestartHealth.PROVIDERS.map((provider, index) => [provider,
      accessResults[index]?.status === 'fulfilled' ? accessResults[index].value : null]));
    healthProviders = MoriRestartHealth.summarize(candidates, results, { enabled: settings.enabled, access });
    healthInventory = { tabs: candidates, results, access };
    healthProvidersAt = Date.now();
    publishHealth();
  })().finally(() => { if (refreshOwner === owner) refreshOwner = null; });
  return owner.promise;
}

async function queryTabs(query) {
  try {
    // Promise.resolve also captures synchronous browser API failures. Catch
    // only this availability boundary; commits outside it remain fail-closed.
    const tabs = await within(Promise.resolve().then(() => chrome.tabs.query(query)));
    if (!Array.isArray(tabs)) throw new Error('invalid_tab_list');
    if (['tab_query_failed', 'tab_query_timeout'].includes(diagnostic)) diagnostic = null;
    return tabs;
  } catch (error) {
    if (!fatalError) diagnostic = error?.message === 'tab_unavailable' ? 'tab_query_timeout' : 'tab_query_failed';
    invalidateHealth();
    return null;
  }
}

async function reconcileTabs() {
  if (!sessions || fatalError) return;
  const generation = controlGeneration;
  const candidates = Object.entries(sessions.tabs).map(([id, sessionId]) => {
    const record = sessions.sessions[sessionId];
    return { id: Number(id), sessionId, sequence: record.sequence, routeRevision: record.routeRevision,
      lease: observerLeases.get(Number(id)) };
  });
  // A URL-filtered query can omit a live tab after host permission is withheld.
  // Use only physical IDs from the unfiltered list to establish absence. No
  // unrelated URL/title is stored, sent, or used as observation metadata.
  const tabs = await queryTabs({});
  if (!tabs || generation !== controlGeneration || fatalError) return;
  const physicalTabs = new Map(tabs.map(tab => [tab.id, tab]));
  await enqueue(async () => {
    if (generation !== controlGeneration || fatalError) return;
    for (const candidate of candidates) {
      // Every preceding commit yields. A newly arrived pause/unpair must stop
      // the remaining entries of this older enumeration as well.
      if (generation !== controlGeneration || admissionBlockReason()) return;
      const record = sessions.sessions[candidate.sessionId];
      if (sessions.tabs[candidate.id] !== candidate.sessionId || !record || record.closed
        || record.sequence !== candidate.sequence || record.routeRevision !== candidate.routeRevision
        || observerLeases.get(candidate.id) !== candidate.lease) continue;
      const tab = physicalTabs.get(candidate.id);
      // Recover a lifecycle mutation rejected under queue pressure. A missing
      // URL is permission uncertainty, never proof that a page is unsupported.
      if (!tab || typeof tab.url === 'string' && !utils.routeForUrl(tab.url))
        await commit(coordinator.closeTab(sessions, candidate.id));
      else if (!candidate.lease && record.observation === 'fresh')
        await commit(coordinator.invalidateTab(sessions, candidate.id));
    }
  });
  if (diagnostic === 'observer_queue_full') diagnostic = null;
  await requestFreshObservations();
}

function statusSnapshot() {
  const records = Object.values(sessions?.sessions || {});
  return {
    ok: !fatalError, version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id, paired: !!credential, enabled: settings.enabled,
    connection: { ...connectionStatus }, diagnostic,
    trackedTabs: records.filter(record => !record.closed).length,
    running: records.filter(record => !record.closed && record.phase === 'running' && record.observation === 'fresh').length,
    unknown: records.filter(record => !record.closed && record.observation !== 'fresh').length,
    pending: outbox.events.length,
    lastObservationAt: records.reduce((latest, record) => Math.max(latest, record.lastObservationAt || 0), 0),
    experimental: true,
    providers: currentHealthProviders(),
    peer: transport?.getPeerInfo?.() || null,
  };
}

async function siteAccessSummary() {
  // A withheld host permission may hide candidate URLs from tabs.query.
  // These two permission counts are not counts of hidden tabs or proof that
  // a temporary per-tab grant is unavailable. Never request broader access.
  const summary = { granted: 0, missing: 0, unknown: 0 };
  const results = await Promise.allSettled(utils.URL_PATTERNS.map(origin =>
    within(Promise.resolve().then(() => chrome.permissions.contains({ origins: [origin] })))));
  for (const result of results) {
    summary[result.status !== 'fulfilled' || typeof result.value !== 'boolean'
      ? 'unknown' : result.value ? 'granted' : 'missing']++;
  }
  return summary;
}

async function tabHealth() {
  // This is an explicit options-page diagnostic, not continuous tab history.
  // Query only origins already granted by the manifest. Probe at most the
  // coordinator limit and return aggregate counts, never URLs/titles/IDs.
  const generation = controlGeneration;
  const [candidates, siteAccess] = await Promise.all([
    within(chrome.tabs.query({ url: utils.URL_PATTERNS })), siteAccessSummary(),
  ]);
  const tabs = candidates.filter(tab => Number.isSafeInteger(tab.id) && tab.id >= 0
    && !!utils.providerForUrl(tab.url));
  const sampled = tabs.slice(0, coordinator.MAX_TABS);
  const results = await Promise.all(sampled.map(async tab => {
    const route = utils.routeForUrl(tab.url);
    const recovery = await observerRecovery.ensure(tab);
    if (!recovery.ok) return { status: recovery.reason === 'unsupported_route' ? 'unsupportedRoute'
      : recovery.disposition === 'failed' ? 'needsReload' : 'unknown', recovery };
    let response;
    try {
      // The page waits for the worker to validate this observation, including
      // the existing bounded current-document check. Keep that handshake out
      // of the observation queue and allow enough time for its two API calls.
      response = await within(chrome.tabs.sendMessage(tab.id, { type: 'mori.health.check' },
        recovery.documentId ? { documentId: recovery.documentId } : { frameId: 0 }), 4000);
    } catch (error) { return { status: error?.message === 'tab_unavailable' ? 'unknown' : 'needsReload', recovery }; }
    if (!response || response.ok !== true || response.v !== 1
      || !['unsupported_route', 'unknown', 'idle', 'running', 'settled'].includes(response.status)) {
      return { status: 'needsReload', recovery };
    }
    // A navigation during the diagnostic must not make an old page appear
    // healthy. No current URL is retained once this local comparison ends.
    try {
      const current = await within(chrome.tabs.get(tab.id));
      if (current.status === 'loading' || current.discarded || current.frozen
        || !utils.sameRoute(route, utils.routeForUrl(current.url))) return { status: 'unknown', recovery };
      const identity = utils.safeObserverIdentity(response);
      if (!identity || !admittedIdentity({ tabId: tab.id, route, identity })) return { status: 'unknown', recovery };
      const active = await currentObserverIdentity(tab.id, identity.pageInstanceId, route);
      if (!active || !admittedIdentity({ tabId: tab.id, route, identity: active })
        || active.binding.epoch !== identity.binding.epoch) return { status: 'unknown', recovery };
      const confirmed = await within(chrome.tabs.get(tab.id));
      if (!availableTab(confirmed, route) || generation !== controlGeneration || admissionBlockReason()) {
        return { status: 'unknown', recovery };
      }
    } catch (_) { return { status: 'unknown', recovery }; }
    return { status: response.status === 'unsupported_route' ? 'unsupportedRoute' : response.status,
      observationAck: utils.safeObservationAck(response.observationAck), recovery };
  }));
  const counts = { needsReload: 0, unsupportedRoute: 0, unknown: 0, idle: 0, running: 0, settled: 0 };
  const observationDelivery = { accepted: 0, rejected: 0, unconfirmed: 0, runningAccepted: 0, reasons: {} };
  const recoverySummary = { attempted: 0, recovered: 0, deferred: 0, failed: 0, reasons: {} };
  for (const result of results) {
    const recovery = result.recovery;
    if (recovery.attempted) recoverySummary.attempted++;
    if (recovery.disposition !== 'healthy') recoverySummary[recovery.disposition]++;
    if (recovery.reason) recoverySummary.reasons[recovery.reason] = (recoverySummary.reasons[recovery.reason] || 0) + 1;
    counts[result.status]++;
    const ack = result.observationAck;
    if (!ack) continue;
    if (ack.ok === true) {
      observationDelivery.accepted++;
      if (result.status === 'running') observationDelivery.runningAccepted++;
    } else {
      observationDelivery[ack.ok === false ? 'rejected' : 'unconfirmed']++;
      observationDelivery.reasons[ack.reason] = (observationDelivery.reasons[ack.reason] || 0) + 1;
    }
  }
  return {
    ok: true, checkedAt: Date.now(), paired: !!credential, enabled: settings.enabled,
    connectionState: connectionStatus.state,
    totalTabs: tabs.length, checkedTabs: sampled.length, remainingTabs: tabs.length - sampled.length,
    counts, observationDelivery, observerRecovery: recoverySummary, siteAccess,
  };
}

async function optionsMessage(message) {
  if (message.type === 'mori.options.status') return statusSnapshot();
  if (message.type === 'mori.options.health') return tabHealth();
  if (fatalError) return { ok: false, reason: fatalError };
  if (message.type === 'mori.options.pair') {
    const code = MoriTransport.parsePairingCode(message.code);
    if (credential && credential.instanceId !== code.instanceId) return { ok: false, reason: 'unpair_first' };
    await enqueue(async () => {
      if (fatalError) throw new Error(fatalError);
      await requiredStorage(() => chrome.storage.local.set({ moriSettings: { enabled: true } }));
      settings = { enabled: true };
    });
    pairingGeneration = controlGeneration;
    try { await transport.pair(message.code); }
    finally { pairingGeneration = null; }
    return { ok: true };
  }
  if (message.type === 'mori.options.retry') {
    await Promise.allSettled([transport.ensureConnected({ immediate: true }), requestFreshObservations()]);
    void flush();
    return { ok: true };
  }
  if (message.type === 'mori.options.enabled' && typeof message.enabled === 'boolean') {
    await enqueue(async () => {
      if (fatalError) throw new Error(fatalError);
      await requiredStorage(() => chrome.storage.local.set({ moriSettings: { enabled: message.enabled } }));
      settings = { enabled: message.enabled };
    });
    return { ok: true };
  }
  if (message.type === 'mori.options.unpair') {
    transport.disconnect('unpaired');
    replayReceiptKeys = null;
    await enqueue(async () => {
      if (fatalError) throw new Error(fatalError);
      await requiredStorage(() => chrome.storage.local.set({ moriCredential: null, moriOutbox: { v: 1, events: [] }, moriMonitoringPreV2: null }));
      migrationBackupWritten = false;
      credential = null; outbox = { v: 1, events: [] }; freshEvents.clear();
      liveReceipts.clear();
      sessions = coordinator.newState(sessions.browserRunId);
      await requiredStorage(() => chrome.storage.session.set({ moriSessions: sessions }));
      diagnostic = null;
    });
    connectionStatus = { state: 'unpaired', code: null };
    return { ok: true };
  }
  return { ok: false, reason: 'unknown_action' };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || typeof message !== 'object' || sender.id !== chrome.runtime.id) return;
  const isOptions = sender.url === chrome.runtime.getURL('options.html');
  if (message.type === 'mori.observer.register') {
    const generation = controlGeneration;
    const operation = initialized.then(() => registerObserver(message, sender, generation));
    if (validContentSender(sender) && (pendingRegistrations.size < coordinator.MAX_TABS || pendingRegistrations.has(sender.tab.id))) pendingRegistrations.set(sender.tab.id, operation);
    operation.finally(() => { if (pendingRegistrations.get(sender.tab?.id) === operation) pendingRegistrations.delete(sender.tab.id); }).catch(() => {});
    operation
      .then(respond).catch(error => respond(utils.safeObservationAck({ ok: false,
        reason: fatalError || error?.message || 'registration_failed' })));
    return true;
  }
  if (message.type === 'mori.observation') {
    if (measurement) {
      try { measurement.ingress?.(measurementReference(message), measurementSample(message), measurementSender(sender)); } catch (_) { measurementFailure(); }
    }
    const generation = controlGeneration;
    initialized.then(() => observationMessage(message, sender, generation))
      .then(respond).catch(error => respond(utils.safeObservationAck({ ok: false,
        reason: fatalError || error?.message || 'observation_failed' })));
    return true;
  }
  if (isOptions && typeof message.type === 'string' && message.type.startsWith('mori.options.')) {
    const control = message.type === 'mori.options.pair' || message.type === 'mori.options.unpair'
      || (message.type === 'mori.options.enabled' && typeof message.enabled === 'boolean');
    // Stop admissions on receipt, before either initialized or optionsQueue.
    // Success is returned only after the common mutation queue persisted it.
    if (control) stopAdmission();
    const operation = initialized.then(() => {
      if (message.type === 'mori.options.status') return optionsMessage(message);
      const result = optionsQueue.then(() => optionsMessage(message));
      optionsQueue = result.catch(() => {});
      return result;
    }).finally(() => { if (control) resumeAdmission(); });
    operation.then(respond)
      .catch(error => respond({ ok: false, reason: /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'action_failed' }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  invalidateRegistrations(tabId);
  provisionalObservers.delete(tabId);
  observationSignatures.delete(tabId);
  completedRegistrations.delete(tabId);
  invalidateHealth();
  observerLeases.delete(tabId);
  revokeProof(tabId); deliveryFailures.delete(tabId);
  for (const [id, attempt] of recoveryAttempts) if (attempt.tabId === tabId) endRecoveryAttempt(id);
  observerRecovery.invalidate(tabId, true);
  const generation = controlGeneration;
  initialized.then(() => enqueue(async () => {
    if (sessions && !admissionBlockReason() && generation === controlGeneration) await commit(coordinator.closeTab(sessions, tabId));
  }, { key: `tab:${tabId}`, priority: true })).catch(reportRecoveryFailure);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.discarded === true || changeInfo.frozen === true
    || changeInfo.url && !utils.routeForUrl(changeInfo.url)) {
    completedRegistrations.delete(tabId); provisionalObservers.delete(tabId);
  }
  if (changeInfo.url || changeInfo.status || changeInfo.discarded !== undefined || changeInfo.frozen !== undefined) invalidateHealth();
  if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.discarded === true || changeInfo.frozen === true) {
    invalidateRegistrations(tabId);
    observationSignatures.delete(tabId);
    observerLeases.delete(tabId);
    let awaitingVerifiedBindingReply = false;
    for (const [id, attempt] of recoveryAttempts) if (attempt.tabId === tabId) {
      const nextRoute = changeInfo.url && utils.routeForUrl(changeInfo.url);
      // A verified empty-document owner may become ready during the SPA URL
      // notification, before the recovery start reply reaches its catch block.
      // Leave that bounded attempt pending until its actual reply. A timeout
      // must still revoke it; URL notification alone cannot finalize handoff.
      const candidate = provisionalCandidates.get(id);
      const sameDocumentCandidate = !!nextRoute && nextRoute.provider === attempt.route.provider
        && changeInfo.status !== 'loading' && changeInfo.discarded !== true && changeInfo.frozen !== true
        && candidate?.documentId === attempt.documentId && candidate.generation === controlGeneration
        && attempt.generation === controlGeneration && attempt.expiresAt > Date.now();
      if (sameDocumentCandidate) awaitingVerifiedBindingReply = true;
      else endRecoveryAttempt(id);
    }
    if (!awaitingVerifiedBindingReply) observerRecovery.invalidate(tabId);
    const generation = controlGeneration;
    initialized.then(() => enqueue(async () => {
      if (!sessions || admissionBlockReason() || generation !== controlGeneration || !sessions.tabs[tabId]) return;
      const result = changeInfo.url && !utils.routeForUrl(changeInfo.url)
        ? coordinator.closeTab(sessions, tabId) : coordinator.invalidateTab(sessions, tabId);
      await commit(result);
    }, { key: `tab:${tabId}`, priority: true })).catch(reportRecoveryFailure);
  }
  if (changeInfo.status === 'complete' || changeInfo.discarded === false || changeInfo.frozen === false || changeInfo.url) {
    initialized.then(() => {
      if (!admissionBlockReason()) return requestFreshObservations();
    }).catch(() => {});
  }
});
function permissionsChanged() {
  invalidateHealth();
  initialized.then(() => requestFreshObservations()).catch(reportRecoveryFailure);
}
chrome.permissions.onAdded?.addListener(permissionsChanged);
chrome.permissions.onRemoved?.addListener(permissionsChanged);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'mori-reconnect') return;
  initialized.then(async () => {
    if (!admissionBlockReason()) {
      await Promise.allSettled([transport.ensureConnected(), reconcileTabs()]);
      void flush();
    }
  }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  initialized.then(() => { void ensureReconnectAlarm(); return reconcileTabs(); }).catch(reportRecoveryFailure);
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  initialized.then(() => { void ensureReconnectAlarm(); return reconcileTabs(); }).catch(reportRecoveryFailure);
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
