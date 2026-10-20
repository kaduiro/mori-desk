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
let flushing = false;
const freshEvents = new Map();
const liveReceipts = new Set();
const eventKey = event => `${event.browserRunId}/${event.sessionId}/${event.eventId}`;
const observerRecovery = MoriObserverRecovery.createRecovery({ chrome, within,
  getBlockReason: () => fatalError ? 'storage_failed' : !settings.enabled ? 'paused' : !credential ? 'unpaired' : null });

function enqueue(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

function failStorage(code = 'storage_failed') {
  fatalError = code;
  transport?.setEnabled(false);
  connectionStatus = { state: 'error', code };
}

function safeCredential(value) {
  if (!value || value.clientId !== clientId || !utils.ID.test(value.instanceId || '')
    || !MoriTransport.PORTS.includes(value.port)) throw new Error('local_data_invalid');
  MoriTransport.fromBase64url(value.key, 32);
  return { clientId, instanceId: value.instanceId, port: value.port, key: value.key };
}

async function initialize() {
  // Access levels are established before reading or writing any credential.
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const local = await chrome.storage.local.get(['moriClientId', 'moriCredential', 'moriSettings', 'moriOutbox']);
  if (!local.moriClientId && (local.moriCredential || local.moriOutbox?.events?.length)) throw new Error('local_data_invalid');
  clientId = local.moriClientId || crypto.randomUUID();
  if (!utils.ID.test(clientId)) throw new Error('local_data_invalid');
  if (!local.moriClientId) await chrome.storage.local.set({ moriClientId: clientId });
  if (local.moriCredential) credential = safeCredential(local.moriCredential);
  if (local.moriSettings) {
    if (typeof local.moriSettings.enabled !== 'boolean') throw new Error('local_data_invalid');
    settings = { enabled: local.moriSettings.enabled };
  }
  if (local.moriOutbox) {
    if (!MoriOutbox.valid(local.moriOutbox)) throw new Error('local_data_invalid');
    outbox = local.moriOutbox;
  }
  const saved = await chrome.storage.session.get('moriSessions');
  sessions = saved.moriSessions || coordinator.newState(crypto.randomUUID());
  if (!coordinator.validState(sessions)) throw new Error('local_data_invalid');
  const recovered = coordinator.recoverDurableEvents(sessions, outbox.events);
  if (!saved.moriSessions || recovered !== sessions) await chrome.storage.session.set({ moriSessions: recovered });
  sessions = recovered;
  transport = new MoriTransport.Transport({
    clientId, browserRunId: sessions.browserRunId,
    getCredential: () => credential,
    saveCredential: async value => {
      const next = safeCredential(value);
      try { await chrome.storage.local.set({ moriCredential: next }); }
      catch (_) { failStorage(); throw new Error('storage_failed'); }
      credential = next;
    },
    onStatus: status => {
      if (status.state !== 'connected') liveReceipts.clear();
      if (!fatalError) connectionStatus = status;
    },
    onReady: async () => {
      await enqueue(async () => { await commit(coordinator.snapshot(sessions)); });
      void flush();
      await requestFreshObservations();
    },
    onFocus: focusRequest,
  });
  await chrome.alarms.create('mori-reconnect', { periodInMinutes: 0.5 });
  transport.setEnabled(settings.enabled);
  await reconcileTabs();
}

const initialized = initialize().catch(error => {
  failStorage(error.message === 'local_data_invalid' ? 'local_data_invalid' : 'storage_failed');
});

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
  if (flushing || fatalError || !settings.enabled || !transport?.isReady()) return;
  flushing = true;
  try {
    while (transport.isReady() && settings.enabled && !fatalError) {
      // Always finish durable receipts before publishing current snapshots.
      const receipt = outbox.events[0];
      if (receipt) {
        const live = liveReceipts.has(eventKey(receipt))
          && receipt.browserRunId === sessions.browserRunId && Date.now() - receipt.observedAt <= 30000;
        const ack = await transport.sendEvent({ ...receipt, replay: !live });
        await enqueue(async () => {
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
      if (freshEvents.get(key)?.eventId === event.eventId) freshEvents.delete(key);
    }
  } catch (_) {
    // The durable outbox remains intact. Connection recovery or the explicit
    // retry button resumes delivery; no terminal event is silently discarded.
  } finally { flushing = false; }
}

function within(promise, milliseconds = 1500) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('tab_unavailable')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function checkCurrentDocument(tabId, pageInstanceId, conversationRef) {
  // Address the currently active top frame, not an old cached document ID.
  const result = await within(chrome.tabs.sendMessage(tabId,
    { type: 'mori.focus.check', pageInstanceId, conversationRef }, { frameId: 0 }));
  return result?.ok === true && result.pageInstanceId === pageInstanceId
    && result.conversationRef === conversationRef;
}

function validContentSender(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0
    && Number.isSafeInteger(sender.tab?.id) && sender.tab.id >= 0
    && utils.ID.test(sender.documentId || '')
    && (!sender.documentLifecycle || sender.documentLifecycle === 'active')
    && !!utils.routeForUrl(sender.url);
}

async function observationMessage(input, sender) {
  if (fatalError) return { ok: false, reason: fatalError };
  if (!settings.enabled || !credential) return { ok: false, reason: 'paused' };
  const observation = utils.safeObservation(input);
  if (!observation || !validContentSender(sender)) return { ok: false, reason: 'invalid_sender' };
  const route = utils.routeForUrl(sender.url);
  const tab = await within(chrome.tabs.get(sender.tab.id));
  const currentRoute = utils.routeForUrl(tab.url);
  if (tab.status === 'loading' || !utils.sameRoute(route, currentRoute)
    || !(await checkCurrentDocument(tab.id, observation.pageInstanceId, route.conversationRef))) {
    return { ok: false, reason: 'old_document' };
  }
  // The page check crosses an async boundary. A route switch while its reply
  // is in flight must not attach the old document's metadata to the new tab.
  const confirmedTab = await within(chrome.tabs.get(tab.id));
  if (confirmedTab.status === 'loading' || !utils.sameRoute(route, utils.routeForUrl(confirmedTab.url))) {
    return { ok: false, reason: 'old_document' };
  }
  const result = coordinator.reduceObservation(sessions, input,
    { route, tabId: tab.id, documentId: sender.documentId });
  await commit(result);
  void transport.ensureConnected();
  if (['invalid_observation', 'old_observation', 'duplicate_observation', 'capacity'].includes(result.diagnostic)) {
    return { ok: false, reason: result.diagnostic };
  }
  return { ok: true };
}

async function validateFocus(request) {
  if (!coordinator.focusMatches(sessions, request)) return null;
  const record = sessions.sessions[request.sessionId];
  const tab = await within(chrome.tabs.get(request.tabId));
  const route = utils.routeForUrl(tab.url);
  if (tab.status === 'loading' || !route || route.provider !== record.provider
    || route.conversationRef !== request.conversationRef
    || !(await checkCurrentDocument(tab.id, request.pageInstanceId, request.conversationRef))) return null;
  if (!coordinator.focusMatches(sessions, request)) return null;
  return tab;
}

async function focusRequest(request) {
  if (fatalError || !settings.enabled || !credential || request.v !== 1) return { ok: false, reason: 'unavailable' };
  try {
    return await within((async () => {
      const tab = await validateFocus(request);
      if (!tab) return { ok: false, reason: 'session_changed' };
      await chrome.tabs.update(tab.id, { active: true });
      const current = await within(chrome.tabs.get(tab.id));
      await chrome.windows.update(current.windowId, { focused: true });
      // Revalidate again after both focus APIs. A navigation or a new session
      // during focus must leave the captured desktop notice unread.
      if (!(await validateFocus(request))) return { ok: false, reason: 'session_changed' };
      return { ok: true };
    })(), 4000);
  } catch (_) { return { ok: false, reason: 'tab_unavailable' }; }
}

async function requestFreshObservations() {
  if (!settings.enabled || !credential || fatalError) return;
  const tabs = await within(chrome.tabs.query({ url: utils.URL_PATTERNS }));
  await Promise.allSettled(tabs.filter(tab => !!utils.routeForUrl(tab.url))
    .slice(0, coordinator.MAX_TABS).map(tab => observerRecovery.ensure(tab)));
}

async function reconcileTabs() {
  if (!sessions || fatalError) return;
  const tabs = await chrome.tabs.query({ url: utils.URL_PATTERNS });
  const ids = new Set(tabs.map(tab => tab.id));
  await enqueue(async () => {
    for (const id of Object.keys(sessions.tabs)) {
      if (!ids.has(Number(id))) await commit(coordinator.closeTab(sessions, Number(id)));
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
      if (response.pageInstanceId !== undefined || response.observerVersion !== undefined || response.route !== undefined) {
        if (!utils.ID.test(response.pageInstanceId || '') || !utils.sameRoute(route, response.route)
          || !(await checkCurrentDocument(tab.id, response.pageInstanceId, route.conversationRef))) {
          return { status: 'unknown', recovery };
        }
        const confirmed = await within(chrome.tabs.get(tab.id));
        if (confirmed.status === 'loading' || confirmed.discarded || confirmed.frozen
          || !utils.sameRoute(route, utils.routeForUrl(confirmed.url))) return { status: 'unknown', recovery };
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
    await chrome.storage.local.set({ moriSettings: { enabled: true } });
    settings = { enabled: true };
    await transport.pair(message.code);
    return { ok: true };
  }
  if (message.type === 'mori.options.retry') {
    await Promise.allSettled([transport.ensureConnected({ immediate: true }), requestFreshObservations()]);
    void flush();
    return { ok: true };
  }
  if (message.type === 'mori.options.enabled' && typeof message.enabled === 'boolean') {
    await chrome.storage.local.set({ moriSettings: { enabled: message.enabled } });
    settings = { enabled: message.enabled };
    transport.setEnabled(settings.enabled);
    if (settings.enabled) await requestFreshObservations();
    return { ok: true };
  }
  if (message.type === 'mori.options.unpair') {
    transport.disconnect('unpaired');
    await enqueue(async () => {
      await chrome.storage.local.set({ moriCredential: null, moriOutbox: { v: 1, events: [] } });
      credential = null; outbox = { v: 1, events: [] }; freshEvents.clear();
      liveReceipts.clear();
      sessions = coordinator.newState(sessions.browserRunId);
      await chrome.storage.session.set({ moriSessions: sessions });
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
  if (message.type === 'mori.observation') {
    initialized.then(() => enqueue(() => observationMessage(message, sender)))
      .then(respond).catch(error => respond(utils.safeObservationAck({ ok: false,
        reason: fatalError || error?.message || 'observation_failed' })));
    return true;
  }
  if (isOptions && typeof message.type === 'string' && message.type.startsWith('mori.options.')) {
    const operation = initialized.then(() => {
      if (message.type === 'mori.options.status') return optionsMessage(message);
      const result = optionsQueue.then(() => optionsMessage(message));
      optionsQueue = result.catch(() => {});
      return result;
    });
    operation.then(respond)
      .catch(error => respond({ ok: false, reason: /^[a-z_]{1,64}$/.test(error.message) ? error.message : 'action_failed' }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  observerRecovery.invalidate(tabId, true);
  initialized.then(() => enqueue(async () => {
    if (sessions && !fatalError) await commit(coordinator.closeTab(sessions, tabId));
  })).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    observerRecovery.invalidate(tabId);
    initialized.then(() => enqueue(async () => {
      if (!sessions || fatalError || !sessions.tabs[tabId]) return;
      const result = changeInfo.url && !utils.routeForUrl(changeInfo.url)
        ? coordinator.closeTab(sessions, tabId) : coordinator.invalidateTab(sessions, tabId);
      await commit(result);
    })).catch(() => {});
  }
  if (changeInfo.status === 'complete' || changeInfo.discarded === false || changeInfo.frozen === false || changeInfo.url) {
    initialized.then(() => {
      if (!fatalError && settings.enabled && credential) return observerRecovery.ensure({ id: tabId });
    }).catch(() => {});
  }
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'mori-reconnect') return;
  initialized.then(async () => {
    if (!fatalError && settings.enabled) {
      await Promise.allSettled([transport.ensureConnected(), requestFreshObservations()]);
      void flush();
    }
  }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  initialized.then(() => reconcileTabs()).catch(() => {});
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
  initialized.then(() => reconcileTabs()).catch(() => {});
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
