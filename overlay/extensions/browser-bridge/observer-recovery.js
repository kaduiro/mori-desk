/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./provider-utils') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriObserverRecovery = api;
})(globalThis, function (utils) {
  'use strict';
  const MAX_TABS = 20;
  const COOLDOWN_MS = 30000;
  const ATTEMPT_TTL_MS = 10000;
  // These packaged installers do not start observation. Only the manifest
  // includes content-start.js; recovery starts with a worker-owned ticket.
  const FILES = Object.freeze(['provider-utils.js', 'adapters/chatgpt.js', 'adapters/claude.js',
    'observation-controller.js', 'conversation-metadata.js', 'conversation-binding.js', 'content-script.js']);

  // Chrome serializes these fixed functions. Neither depends on a worker
  // closure or reads page content, composer, cookies, or credentials.
  function inspectDocument() {
    return { url: location.origin + location.pathname, readyState: document.readyState,
      active: !document.prerendering && document.visibilityState !== 'prerender' };
  }
  function startObserver(attemptId) {
    return globalThis.MoriBrowserObserver?.start({ attemptId });
  }
  function tabReason(tab) {
    if (!utils.routeForUrl(tab?.url)) return 'unsupported_route';
    if (tab.discarded) return 'tab_discarded';
    if (tab.frozen) return 'tab_frozen';
    if (tab.status === 'loading') return 'tab_loading';
    return null;
  }

  function createRecovery({ chrome, within, getBlockReason, beginAttempt, endAttempt,
    isAdmitted, now = () => Date.now() }) {
    const pending = new Map();
    const attemptedAt = new Map();
    const result = (disposition, reason = null, attempted = false, extra = {}) => ({
      ok: disposition === 'healthy' || disposition === 'recovered', disposition, reason, attempted, ...extra,
    });
    const timeout = error => error?.message === 'tab_unavailable';

    async function current(entry, route) {
      if (entry.invalidated) throw new Error('navigation_changed');
      let tab;
      try { tab = await within(chrome.tabs.get(entry.tabId)); }
      catch (_) { throw new Error('navigation_changed'); }
      if (entry.invalidated || !utils.sameRoute(route, utils.routeForUrl(tab.url))) throw new Error('navigation_changed');
      const reason = tabReason(tab);
      if (reason) throw new Error(reason);
      return tab;
    }
    async function probe(tabId, route, documentId, expectedPage) {
      const response = await within(chrome.tabs.sendMessage(tabId, { type: 'mori.observer.identity',
        ...(expectedPage ? { pageInstanceId: expectedPage, conversationRef: route.conversationRef } : {}) },
      documentId ? { documentId } : { frameId: 0 }));
      const identity = utils.safeObserverIdentity(response);
      if (!identity) return null;
      if (!utils.sameRoute(route, identity.route) || identity.route.conversationRef !== route.conversationRef
        || (expectedPage && identity.pageInstanceId !== expectedPage)) return { changed: true };
      return identity;
    }
    async function currentIdentity(tabId, route, identity) {
      const current = await probe(tabId, route, null, identity.pageInstanceId);
      return current && !current.changed && current.observerVersion === identity.observerVersion
        && current.binding.state === identity.binding.state && current.binding.epoch === identity.binding.epoch
        ? current : null;
    }
    async function documentSnapshot(tabId, route) {
      const results = await within(chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'ISOLATED', injectImmediately: true, func: inspectDocument,
      }));
      const top = results?.length === 1 && results[0];
      if (!top || top.frameId !== 0 || !utils.ID.test(top.documentId || '') || !top.result) {
        throw new Error('observer_unavailable');
      }
      if (!top.result.active || !utils.sameRoute(route, utils.routeForUrl(top.result.url))) throw new Error('navigation_changed');
      if (top.result.readyState === 'loading') throw new Error('tab_loading');
      return top.documentId;
    }
    async function triggerObservation(tabId, documentId) {
      // Bootstrap never doubles as an observation or business focus success.
      try {
        await within(chrome.tabs.sendMessage(tabId, { type: 'mori.observe.now' },
          documentId ? { documentId } : { frameId: 0 }), 4000);
      } catch (_) {}
    }
    async function injectionFailure(entry, route, error) {
      // Chrome error prose can contain URLs and extension IDs; retain categories only.
      const blocked = getBlockReason();
      if (blocked) return result('deferred', blocked, true);
      try { await current(entry, route); }
      catch (changed) { return result('deferred', changed.message, true); }
      if (timeout(error)) return result('failed', 'recovery_timeout', true);
      if (['observer_unavailable', 'lease_invalid'].includes(error?.message)) {
        return result('failed', error.message, true);
      }
      if (['navigation_changed', 'tab_loading', 'attempt_expired', 'binding_unconfirmed'].includes(error?.message)) {
        return result('deferred', error.message, true);
      }
      try {
        const origin = route.provider === 'chatgpt' ? 'https://chatgpt.com/*' : 'https://claude.ai/*';
        if (await within(chrome.permissions.contains({ origins: [origin] })) === false) {
          return result('failed', 'permission_required', true);
        }
      } catch (_) {}
      return result('failed', 'injection_failed', true);
    }

    async function run(entry, requestedTab) {
      let tab;
      try { tab = await within(chrome.tabs.get(entry.tabId)); }
      catch (_) { return result('deferred', 'navigation_changed'); }
      const route = utils.routeForUrl(tab.url);
      const initialReason = tabReason(tab) || getBlockReason();
      if (initialReason) return result('deferred', initialReason);
      if (entry.invalidated || (requestedTab.url && !utils.sameRoute(route, utils.routeForUrl(requestedTab.url)))) {
        return result('deferred', 'navigation_changed');
      }
      let identity;
      try { identity = await probe(tab.id, route); }
      catch (error) {
        // A timed-out but possibly alive page must not acquire a second owner.
        if (timeout(error)) return result('deferred', 'probe_timeout');
      }
      const existing = identity && !identity.changed && identity.observerVersion === chrome.runtime.getManifest().version;
      if (identity?.changed) return result('deferred', 'navigation_changed');
      if (existing) {
        try {
          await current(entry, route);
          identity = await currentIdentity(tab.id, route, identity);
          if (!identity) return result('deferred', 'navigation_changed');
          await current(entry, route);
        } catch (error) {
          const reason = timeout(error) ? 'probe_timeout'
            : ['tab_loading', 'tab_discarded', 'tab_frozen'].includes(error?.message) ? error.message : 'navigation_changed';
          return result('deferred', reason);
        }
        const blocked = getBlockReason();
        if (blocked) return result('deferred', blocked);
        if (identity.binding.state !== 'confirmed') return result('deferred', 'binding_unconfirmed');
        if (isAdmitted?.({ tabId: tab.id, route, identity })) {
          await triggerObservation(tab.id);
          if (getBlockReason() || !isAdmitted?.({ tabId: tab.id, route, identity })) {
            return result('deferred', getBlockReason() || 'attempt_expired');
          }
          return result('healthy', null, false, { route, identity });
        }
      }
      let blocked = getBlockReason();
      if (blocked) return result('deferred', blocked);
      for (const [id, at] of attemptedAt) if (now() - at >= COOLDOWN_MS) attemptedAt.delete(id);
      if (attemptedAt.has(tab.id)) return result('deferred', 'recovery_cooldown');
      if (attemptedAt.size >= MAX_TABS) return result('deferred', 'recovery_limit');
      if (!chrome.scripting?.executeScript) return result('failed', 'scripting_unavailable');
      if (typeof beginAttempt !== 'function' || typeof endAttempt !== 'function') {
        return result('failed', 'lease_invalid');
      }
      attemptedAt.set(tab.id, now());
      try {
        await current(entry, route);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        const documentId = await documentSnapshot(tab.id, route);
        await current(entry, route);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        entry.attemptId = beginAttempt({ tabId: tab.id, documentId, route,
          pageInstanceId: existing ? identity.pageInstanceId : null, expiresAt: now() + ATTEMPT_TTL_MS });
        if (!utils.ID.test(entry.attemptId || '')) return result('deferred', 'attempt_expired', true);
        if (!existing) {
          await within(chrome.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [documentId] }, world: 'ISOLATED', injectImmediately: true,
            files: [...FILES],
          }), 4000);
        }
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        await current(entry, route);
        // A -> B -> A can replace the document while keeping its URL.
        if (await documentSnapshot(tab.id, route) !== documentId) return result('deferred', 'navigation_changed', true);
        const started = await within(chrome.scripting.executeScript({
          target: { tabId: tab.id, documentIds: [documentId] }, world: 'ISOLATED', injectImmediately: true,
          func: startObserver, args: [entry.attemptId],
        }), 4000);
        const registration = started?.length === 1 && started[0].frameId === 0
          && started[0].documentId === documentId && started[0].result;
        if (registration?.ok !== true) {
          throw new Error(['binding_unconfirmed', 'attempt_expired'].includes(registration?.reason)
            ? registration.reason : 'lease_invalid');
        }
        await current(entry, route);
        try { identity = await probe(tab.id, route, documentId, existing ? identity.pageInstanceId : null); }
        catch (error) { throw new Error(timeout(error) ? 'tab_unavailable' : 'observer_unavailable'); }
        if (!identity || identity.changed || identity.observerVersion !== chrome.runtime.getManifest().version) {
          return result('failed', 'observer_unavailable', true);
        }
        identity = await currentIdentity(tab.id, route, identity);
        if (!identity) return result('deferred', 'navigation_changed', true);
        await current(entry, route);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        if (identity.binding.state !== 'confirmed') return result('deferred', 'binding_unconfirmed', true);
        if (!isAdmitted?.({ tabId: tab.id, documentId, route, identity })) {
          return result('failed', 'lease_invalid', true);
        }
        await triggerObservation(tab.id, documentId);
        if (getBlockReason() || !isAdmitted?.({ tabId: tab.id, documentId, route, identity })) {
          return result('deferred', getBlockReason() || 'attempt_expired', true);
        }
        entry.completed = true;
        return result('recovered', null, true, { route, identity, documentId });
      } catch (error) {
        // A timeout does not cancel Chrome's pending execution. Revoke before
        // awaiting diagnostic API calls, which may themselves be unavailable.
        if (entry.attemptId) endAttempt(entry.attemptId, { retainLease: false });
        return await injectionFailure(entry, route, error);
      }
      finally { if (entry.attemptId) endAttempt(entry.attemptId, { retainLease: entry.completed === true }); }
    }
    function ensure(tab) {
      if (!Number.isSafeInteger(tab?.id) || tab.id < 0) return Promise.resolve(result('deferred', 'navigation_changed'));
      if (pending.has(tab.id)) return pending.get(tab.id).promise;
      if (pending.size >= MAX_TABS) return Promise.resolve(result('deferred', 'recovery_limit'));
      const entry = { tabId: tab.id, invalidated: false, promise: null, attemptId: null };
      pending.set(tab.id, entry);
      entry.promise = run(entry, tab).catch(() => result('failed', 'observer_unavailable'))
        .finally(() => { if (pending.get(tab.id) === entry) pending.delete(tab.id); });
      return entry.promise;
    }
    function invalidate(tabId, removed = false) {
      const entry = pending.get(tabId);
      if (entry) {
        entry.invalidated = true;
        if (entry.attemptId) endAttempt?.(entry.attemptId, { retainLease: false });
      }
      if (removed) attemptedAt.delete(tabId);
    }
    function invalidateAll() { for (const tabId of pending.keys()) invalidate(tabId); }
    return { ensure, invalidate, invalidateAll };
  }
  return { MAX_TABS, COOLDOWN_MS, ATTEMPT_TTL_MS, FILES, createRecovery };
});
