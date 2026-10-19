/* SPDX-License-Identifier: AGPL-3.0-only */
importScripts('provider-utils.js', 'session-coordinator.js', 'outbox.js', 'transport.js');

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
  await commit(coordinator.reduceObservation(sessions, input,
    { route, tabId: tab.id, documentId: sender.documentId }));
  void transport.ensureConnected();
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
  const tabs = await chrome.tabs.query({ url: utils.URL_PATTERNS });
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id,
    { type: 'mori.observe.now' }, { frameId: 0 })));
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

async function optionsMessage(message) {
  if (message.type === 'mori.options.status') return statusSnapshot();
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
    await transport.ensureConnected();
    await requestFreshObservations(); void flush();
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
      .then(respond).catch(() => respond({ ok: false, reason: fatalError || diagnostic || 'observation_failed' }));
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
  initialized.then(() => enqueue(async () => {
    if (sessions && !fatalError) await commit(coordinator.closeTab(sessions, tabId));
  })).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  initialized.then(() => enqueue(async () => {
    if (!sessions || fatalError || !sessions.tabs[tabId]) return;
    const result = changeInfo.url && !utils.routeForUrl(changeInfo.url)
      ? coordinator.closeTab(sessions, tabId) : coordinator.invalidateTab(sessions, tabId);
    await commit(result);
  })).catch(() => {});
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'mori-reconnect') return;
  initialized.then(async () => {
    if (!fatalError && settings.enabled) { await transport.ensureConnected(); void flush(); }
  }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  initialized.then(() => reconcileTabs()).catch(() => {});
});
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
