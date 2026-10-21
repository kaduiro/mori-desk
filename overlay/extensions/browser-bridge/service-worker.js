/* SPDX-License-Identifier: AGPL-3.0-only */
importScripts('provider-utils.js', 'session-coordinator.js', 'outbox.js', 'transport.js', 'observer-recovery.js');

'use strict';
const utils = MoriProviderUtils;
const coordinator = MoriSessionCoordinator;
let clientId;
let credential = null;
let settings = { enabled: true };
let sessions;
let outbox = { v: 1, events: [] };
let transport;
let fatalError = null;
let diagnostic = null;
let connectionStatus = { state: 'loading', code: null };
let queue = Promise.resolve();
let optionsQueue = Promise.resolve();
let controlGeneration = 0;
let pendingControls = 0;
let pairingGeneration = null;
let flushing = null;
// Registration is deliberately not restored from storage.session. A new
// worker must verify the current observer again without resetting its timer
// or generation controller merely because this grant epoch changed.
const workerEpoch = crypto.randomUUID();
const observerLeases = new Map();
const recoveryAttempts = new Map();
const freshEvents = new Map();
const liveReceipts = new Set();
const eventKey = event => `${event.browserRunId}/${event.sessionId}/${event.eventId}`;
const observerRecovery = MoriObserverRecovery.createRecovery({ chrome, within,
  getBlockReason: admissionBlockReason, beginAttempt: beginRecoveryAttempt,
  endAttempt: endRecoveryAttempt, isAdmitted: admittedIdentity });

function admissionBlockReason() {
  return fatalError || (pendingControls || !settings.enabled ? 'paused' : !credential ? 'unpaired' : null);
}

function beginRecoveryAttempt(target) {
  if (admissionBlockReason()) return null;
  for (const [id, attempt] of recoveryAttempts) {
    if (attempt.expiresAt <= Date.now() || attempt.tabId === target.tabId) endRecoveryAttempt(id);
  }
  if (recoveryAttempts.size >= coordinator.MAX_TABS) return null;
  const attemptId = crypto.randomUUID();
  recoveryAttempts.set(attemptId, { ...target, generation: controlGeneration });
  return attemptId;
}

function endRecoveryAttempt(attemptId, { retainLease = false } = {}) {
  recoveryAttempts.delete(attemptId);
  if (!retainLease) for (const [tabId, lease] of observerLeases) {
    if (lease.attemptId === attemptId) observerLeases.delete(tabId);
  }
}

function validAttempt(attemptId, sender, pageInstanceId, route, generation) {
  if (attemptId === null) return true; // the manifest's initial start
  const attempt = recoveryAttempts.get(attemptId);
  return !!attempt && attempt.expiresAt > Date.now() && attempt.generation === generation
    && attempt.tabId === sender.tab.id && attempt.documentId === sender.documentId
    && (!attempt.pageInstanceId || attempt.pageInstanceId === pageInstanceId)
    && utils.sameRoute(route, attempt.route);
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
  observerLeases.clear();
  recoveryAttempts.clear();
  observerRecovery.invalidateAll();
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

function enqueue(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

function failStorage(code = 'storage_failed') {
  fatalError = code;
  observerLeases.clear();
  recoveryAttempts.clear();
  observerRecovery.invalidateAll();
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
  const local = await requiredStorage(() => chrome.storage.local.get(['moriClientId', 'moriCredential', 'moriSettings', 'moriOutbox']));
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
      if (status.state !== 'connected') liveReceipts.clear();
      if (!fatalError) connectionStatus = status;
    },
    onReady: transportReady,
    onFocus: focusRequest,
  });
  transport.setEnabled(settings.enabled && !pendingControls);
}

async function transportReady() {
  const generation = controlGeneration;
  await enqueue(async () => {
    if (generation === controlGeneration && !admissionBlockReason()) await commit(coordinator.snapshot(sessions));
  });
  if (generation !== controlGeneration || admissionBlockReason()) return;
  void flush();
  await requestFreshObservations();
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

function reportRecoveryFailure() {
  if (!fatalError) diagnostic = 'recovery_failed';
}

async function ensureReconnectAlarm() {
  try {
    await within(Promise.resolve().then(() => chrome.alarms.create('mori-reconnect', { periodInMinutes: 0.5 })));
    if (diagnostic === 'alarm_failed') diagnostic = null;
  } catch (_) { if (!fatalError) diagnostic = 'alarm_failed'; }
}

async function commit(result) {
  if (fatalError) throw new Error(fatalError);
  const critical = result.events.filter(event => event.kind === 'terminal' || event.kind === 'closed');
  let nextOutbox;
  try { nextOutbox = MoriOutbox.append(outbox, critical); }
  catch (error) {
    diagnostic = error.message;
    throw error;
  }
  try {
    if (critical.length) {
      // Durable terminal metadata is written before the session state and wire.
      await chrome.storage.local.set({ moriOutbox: nextOutbox });
      outbox = nextOutbox;
    }
    await chrome.storage.session.set({ moriSessions: result.state });
    sessions = result.state;
  } catch (_) { failStorage(); throw new Error('storage_failed'); }
  if (result.diagnostic && !['duplicate_observation', 'old_observation'].includes(result.diagnostic)) diagnostic = result.diagnostic;
  if (diagnostic === 'unsupported' && !Object.values(sessions.sessions).some(record => !record.closed && record.observation === 'unsupported')) diagnostic = null;
  if (diagnostic === 'capacity' && Object.keys(sessions.tabs).length < coordinator.MAX_TABS
    && Object.keys(sessions.sessions).length < coordinator.MAX_RECORDS) diagnostic = null;
  for (const event of result.events) {
    const key = `${event.browserRunId}/${event.sessionId}`;
    if (event.kind === 'terminal' || event.kind === 'closed') {
      if (transport?.isReady()) liveReceipts.add(eventKey(event));
      const pending = freshEvents.get(key);
      if (pending && pending.sequence <= event.sequence) freshEvents.delete(key);
    } else freshEvents.set(key, event);
  }
  void flush();
}

async function flush() {
  if (flushing?.generation === controlGeneration || admissionBlockReason() || !transport?.isReady()) return;
  const owner = { generation: controlGeneration, credential };
  flushing = owner;
  try {
    while (transport.isReady() && !admissionBlockReason() && owner.generation === controlGeneration
      && owner.credential === credential) {
      // Always finish durable receipts before publishing current snapshots.
      const receipt = outbox.events[0];
      if (receipt) {
        const live = liveReceipts.has(eventKey(receipt))
          && receipt.browserRunId === sessions.browserRunId && Date.now() - receipt.observedAt <= 30000;
        const ack = await transport.sendEvent({ ...receipt, replay: !live });
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
        }).catch(() => { failStorage(); throw new Error('storage_failed'); });
        continue;
      }
      const pending = freshEvents.entries().next();
      if (pending.done) break;
      const [key, event] = pending.value;
      // A queued observation may have aged while the desktop was offline.
      const aged = Date.now() - event.observedAt > 30000;
      const outgoing = aged ? { ...event, replay: true, observation: 'stale' } : event;
      await transport.sendEvent(outgoing);
      if (owner.generation === controlGeneration && owner.credential === credential
        && freshEvents.get(key)?.eventId === event.eventId) freshEvents.delete(key);
    }
  } catch (_) {
    // The durable outbox remains intact. Connection recovery or the explicit
    // retry button resumes delivery; no terminal event is silently discarded.
  } finally { if (flushing === owner) flushing = null; }
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

function validContentSender(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0
    && Number.isSafeInteger(sender.tab?.id) && sender.tab.id >= 0
    && utils.ID.test(sender.documentId || '')
    && (!sender.documentLifecycle || sender.documentLifecycle === 'active')
    && !!utils.routeForUrl(sender.url);
}

function availableTab(tab, route) {
  return tab && tab.status !== 'loading' && !tab.discarded && !tab.frozen
    && utils.sameRoute(route, utils.routeForUrl(tab.url));
}

function grantResult(lease) {
  return { ok: true, v: 1, workerEpoch, leaseId: lease.leaseId,
    pageInstanceId: lease.pageInstanceId, bindingEpoch: lease.bindingEpoch };
}

async function registerObserver(input, sender, generation) {
  if (admissionBlockReason() || generation !== controlGeneration) {
    return { ok: false, reason: fatalError || 'paused' };
  }
  const registration = utils.safeObserverRegister(input);
  if (!registration || !validContentSender(sender)) return { ok: false, reason: 'invalid_sender' };
  if (registration.observerVersion !== chrome.runtime.getManifest().version) return { ok: false, reason: 'observer_version' };
  const route = utils.routeForUrl(sender.url);
  if (!validAttempt(registration.attemptId, sender, registration.pageInstanceId, route, generation)) {
    return { ok: false, reason: 'attempt_expired' };
  }
  const tab = await within(chrome.tabs.get(sender.tab.id));
  if (!availableTab(tab, route)) return { ok: false, reason: 'old_document' };
  const identity = await currentObserverIdentity(tab.id, registration.pageInstanceId, route);
  if (!identity) return { ok: false, reason: 'old_document' };
  const current = await within(chrome.tabs.get(tab.id));
  if (!availableTab(current, route)) return { ok: false, reason: 'old_document' };
  // Registration probes stay outside the mutation queue: an injected start
  // waits for this response and must never wait on its own recovery operation.
  return enqueue(() => {
    if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
    if (!validAttempt(registration.attemptId, sender, registration.pageInstanceId, route, generation)) {
      return { ok: false, reason: 'attempt_expired' };
    }
    if (identity.binding.state !== 'confirmed') {
      observerLeases.delete(tab.id);
      diagnostic = 'binding_unconfirmed';
      return { ok: false, reason: 'binding_unconfirmed' };
    }
    const existing = observerLeases.get(tab.id);
    if (!existing && observerLeases.size >= coordinator.MAX_TABS) return { ok: false, reason: 'capacity' };
    const sameOwner = existing && existing.generation === generation && existing.documentId === sender.documentId
      && existing.pageInstanceId === registration.pageInstanceId && existing.bindingEpoch === identity.binding.epoch
      && utils.sameRoute(existing.route, route);
    const lease = { workerEpoch, leaseId: sameOwner ? existing.leaseId : crypto.randomUUID(),
      pageInstanceId: registration.pageInstanceId, bindingEpoch: identity.binding.epoch, tabId: tab.id,
      documentId: sender.documentId, route, generation, attemptId: registration.attemptId };
    observerLeases.set(tab.id, lease);
    if (diagnostic === 'binding_unconfirmed') diagnostic = null;
    return grantResult(lease);
  });
}

async function observationMessage(input, sender, generation) {
  if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
  const observation = utils.safeObservation(input);
  if (!observation || !validContentSender(sender)) return { ok: false, reason: 'invalid_sender' };
  const route = utils.routeForUrl(sender.url);
  const lease = observerLeases.get(sender.tab.id);
  if (!utils.safeLease(observation) || !lease || !leaseFieldsMatch(lease, observation)
    || lease.generation !== generation) return { ok: false, reason: 'lease_invalid' };
  if (lease.pageInstanceId !== observation.pageInstanceId || lease.documentId !== sender.documentId
    || !utils.sameRoute(route, lease.route)) return { ok: false, reason: 'old_document' };
  const tab = await within(chrome.tabs.get(sender.tab.id));
  if (!availableTab(tab, route)) return { ok: false, reason: 'old_document' };
  const identity = await currentObserverIdentity(tab.id, observation.pageInstanceId, route);
  if (!identity) return { ok: false, reason: 'old_document' };
  if (identity.binding.state !== 'confirmed') return { ok: false, reason: 'binding_unconfirmed' };
  if (!admittedIdentity({ tabId: tab.id, documentId: sender.documentId, route, identity })) {
    return { ok: false, reason: 'lease_invalid' };
  }
  // The page check crosses an async boundary. A route switch while its reply
  // is in flight must not attach the old document's metadata to the new tab.
  const confirmedTab = await within(chrome.tabs.get(tab.id));
  if (!availableTab(confirmedTab, route)) {
    return { ok: false, reason: 'old_document' };
  }
  if (admissionBlockReason() || generation !== controlGeneration) return { ok: false, reason: fatalError || 'paused' };
  if (observerLeases.get(tab.id) !== lease) return { ok: false, reason: 'lease_expired' };
  // No asynchronous work may be inserted between this final gate and commit.
  // Once the first write starts, a later control waits for this commit to settle.
  const result = coordinator.reduceObservation(sessions, input,
    { route, tabId: tab.id, documentId: sender.documentId });
  await commit(result);
  void transport.ensureConnected();
  if (['invalid_observation', 'old_observation', 'duplicate_observation', 'capacity'].includes(result.diagnostic)) {
    return { ok: false, reason: result.diagnostic };
  }
  return { ok: true };
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
  const tabs = await queryTabs({ url: utils.URL_PATTERNS });
  if (!tabs || generation !== controlGeneration || admissionBlockReason()) return;
  await Promise.allSettled(tabs.filter(tab => !!utils.routeForUrl(tab.url))
    .slice(0, coordinator.MAX_TABS).map(tab => observerRecovery.ensure(tab)));
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
    return null;
  }
}

async function reconcileTabs() {
  if (!sessions || fatalError) return;
  const generation = controlGeneration;
  const candidates = Object.entries(sessions.tabs).map(([id, sessionId]) => {
    const record = sessions.sessions[sessionId];
    return { id: Number(id), sessionId, sequence: record.sequence, routeRevision: record.routeRevision };
  });
  // A URL-filtered query can omit a live tab after host permission is withheld.
  // Use only physical IDs from the unfiltered list to establish absence. No
  // unrelated URL/title is stored, sent, or used as observation metadata.
  const tabs = await queryTabs({});
  if (!tabs || generation !== controlGeneration || fatalError) return;
  const ids = new Set(tabs.map(tab => tab.id));
  await enqueue(async () => {
    if (generation !== controlGeneration || fatalError) return;
    for (const candidate of candidates) {
      // Every preceding commit yields. A newly arrived pause/unpair must stop
      // the remaining entries of this older enumeration as well.
      if (generation !== controlGeneration || admissionBlockReason()) return;
      const record = sessions.sessions[candidate.sessionId];
      if (sessions.tabs[candidate.id] !== candidate.sessionId || !record || record.closed
        || record.sequence !== candidate.sequence || record.routeRevision !== candidate.routeRevision) continue;
      if (!ids.has(candidate.id)) await commit(coordinator.closeTab(sessions, candidate.id));
    }
  });
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
    await enqueue(async () => {
      if (fatalError) throw new Error(fatalError);
      await requiredStorage(() => chrome.storage.local.set({ moriCredential: null, moriOutbox: { v: 1, events: [] } }));
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
    initialized.then(() => registerObserver(message, sender, generation))
      .then(respond).catch(error => respond(utils.safeObservationAck({ ok: false,
        reason: fatalError || error?.message || 'registration_failed' })));
    return true;
  }
  if (message.type === 'mori.observation') {
    const generation = controlGeneration;
    initialized.then(() => enqueue(() => observationMessage(message, sender, generation)))
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
  observerLeases.delete(tabId);
  for (const [id, attempt] of recoveryAttempts) if (attempt.tabId === tabId) endRecoveryAttempt(id);
  observerRecovery.invalidate(tabId, true);
  const generation = controlGeneration;
  initialized.then(() => enqueue(async () => {
    if (sessions && !admissionBlockReason() && generation === controlGeneration) await commit(coordinator.closeTab(sessions, tabId));
  })).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    observerLeases.delete(tabId);
    for (const [id, attempt] of recoveryAttempts) if (attempt.tabId === tabId) endRecoveryAttempt(id);
    observerRecovery.invalidate(tabId);
    const generation = controlGeneration;
    initialized.then(() => enqueue(async () => {
      if (!sessions || admissionBlockReason() || generation !== controlGeneration || !sessions.tabs[tabId]) return;
      const result = changeInfo.url && !utils.routeForUrl(changeInfo.url)
        ? coordinator.closeTab(sessions, tabId) : coordinator.invalidateTab(sessions, tabId);
      await commit(result);
    })).catch(() => {});
  }
  if (changeInfo.status === 'complete' || changeInfo.discarded === false || changeInfo.frozen === false || changeInfo.url) {
    initialized.then(() => {
      if (!admissionBlockReason()) return observerRecovery.ensure({ id: tabId });
    }).catch(() => {});
  }
});
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
