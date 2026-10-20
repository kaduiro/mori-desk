/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./provider-utils') : root.MoriProviderUtils);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriObserverRecovery = api;
})(globalThis, function (utils) {
  'use strict';
  const MAX_TABS = 20;
  const COOLDOWN_MS = 30000;
  // Packaged extension files, in manifest order. No page-provided source,
  // network code, or main-world script is executed.
  const FILES = Object.freeze(['provider-utils.js', 'adapters/chatgpt.js', 'adapters/claude.js',
    'observation-controller.js', 'conversation-metadata.js', 'content-script.js']);

  // Chrome serializes this fixed function. It has no closure and reads no DOM
  // content, composer, cookies, or credentials. The API supplies documentId.
  function inspectDocument() {
    return { url: location.origin + location.pathname, readyState: document.readyState,
      active: !document.prerendering && document.visibilityState !== 'prerender' };
  }

  function tabReason(tab) {
    if (!utils.routeForUrl(tab?.url)) return 'unsupported_route';
    if (tab.discarded) return 'tab_discarded';
    if (tab.frozen) return 'tab_frozen';
    if (tab.status === 'loading') return 'tab_loading';
    return null;
  }

  function readyResponse(response, route) {
    if (!response || response.ok !== true) return null;
    // A healthy older release returns this small acknowledgement. Missing
    // identity/version fields alone are not grounds to replace its observer.
    if (response.v === undefined && response.observerVersion === undefined
      && response.pageInstanceId === undefined && response.route === undefined) return { legacy: true };
    if (response.v !== 1 || !utils.ID.test(response.pageInstanceId || '')
      || typeof response.observerVersion !== 'string'
      || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(response.observerVersion)
      || response.observerVersion.length > 48 || !response.route) return null;
    if (!utils.sameRoute(route, response.route)
      || response.route.conversationRef !== route.conversationRef) return { changed: true };
    return { legacy: false, pageInstanceId: response.pageInstanceId,
      observerVersion: response.observerVersion, conversationRef: route.conversationRef };
  }

  function createRecovery({ chrome, within, getBlockReason, now = () => Date.now() }) {
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

    async function probe(tabId, route, documentId) {
      const response = await within(chrome.tabs.sendMessage(tabId, { type: 'mori.observe.now' },
        documentId ? { documentId } : { frameId: 0 }));
      return readyResponse(response, route);
    }

    async function currentIdentity(tabId, identity) {
      if (identity.legacy) return true;
      const response = await within(chrome.tabs.sendMessage(tabId, { type: 'mori.focus.check',
        pageInstanceId: identity.pageInstanceId, conversationRef: identity.conversationRef }, { frameId: 0 }));
      return response?.ok === true && response.pageInstanceId === identity.pageInstanceId
        && response.conversationRef === identity.conversationRef;
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

    async function injectionFailure(entry, route, error) {
      // Chrome error prose may contain a URL or extension ID; never forward it.
      const blocked = getBlockReason();
      if (blocked) return result('deferred', blocked, true);
      try { await current(entry, route); }
      catch (changed) { return result('deferred', changed.message, true); }
      if (timeout(error)) return result('failed', 'recovery_timeout', true);
      if (error?.message === 'observer_unavailable') return result('failed', 'observer_unavailable', true);
      if (error?.message === 'navigation_changed' || error?.message === 'tab_loading') {
        return result('deferred', error.message, true);
      }
      // contains(false) is an explanation after an API failure, not a gate:
      // a temporary per-tab grant may still permit injection.
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
      const initialReason = tabReason(tab);
      if (initialReason) return result('deferred', initialReason);
      if (entry.invalidated || (requestedTab.url && !utils.sameRoute(route, utils.routeForUrl(requestedTab.url)))) {
        return result('deferred', 'navigation_changed');
      }
      let identity;
      try { identity = await probe(tab.id, route); }
      catch (error) {
        // A timed-out but possibly alive page must not acquire a second
        // observer. Retry after it resumes, without activating/reloading it.
        if (timeout(error)) return result('deferred', 'probe_timeout');
      }
      if (identity) {
        if (identity.changed) return result('deferred', 'navigation_changed');
        try {
          await current(entry, route);
          if (!(await currentIdentity(tab.id, identity))) return result('deferred', 'navigation_changed');
          await current(entry, route);
        } catch (error) {
          const reason = timeout(error) ? 'probe_timeout'
            : ['tab_loading', 'tab_discarded', 'tab_frozen'].includes(error?.message) ? error.message : 'navigation_changed';
          return result('deferred', reason);
        }
        return result('healthy', null, false, { route, identity });
      }
      let blocked = getBlockReason();
      if (blocked) return result('deferred', blocked);
      for (const [id, at] of attemptedAt) if (now() - at >= COOLDOWN_MS) attemptedAt.delete(id);
      if (attemptedAt.has(tab.id)) return result('deferred', 'recovery_cooldown');
      if (attemptedAt.size >= MAX_TABS) return result('deferred', 'recovery_limit');
      if (!chrome.scripting?.executeScript) return result('failed', 'scripting_unavailable');
      attemptedAt.set(tab.id, now());
      try {
        await current(entry, route);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        const documentId = await documentSnapshot(tab.id, route);
        await current(entry, route);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        await within(chrome.scripting.executeScript({
          target: { tabId: tab.id, documentIds: [documentId] }, world: 'ISOLATED', injectImmediately: true,
          files: [...FILES],
        }), 4000);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        await current(entry, route);
        // Same URL is not enough: A -> B -> A may have replaced the document.
        if (await documentSnapshot(tab.id, route) !== documentId) return result('deferred', 'navigation_changed', true);
        try { identity = await probe(tab.id, route, documentId); }
        catch (error) { throw new Error(timeout(error) ? 'tab_unavailable' : 'observer_unavailable'); }
        if (!identity || identity.legacy || identity.changed
          || identity.observerVersion !== chrome.runtime.getManifest().version) {
          return result('failed', 'observer_unavailable', true);
        }
        if (!(await currentIdentity(tab.id, identity))) return result('deferred', 'navigation_changed', true);
        await current(entry, route);
        blocked = getBlockReason();
        if (blocked) return result('deferred', blocked, true);
        return result('recovered', null, true, { route, identity, documentId });
      } catch (error) { return injectionFailure(entry, route, error); }
    }

    function ensure(tab) {
      if (!Number.isSafeInteger(tab?.id) || tab.id < 0) return Promise.resolve(result('deferred', 'navigation_changed'));
      if (pending.has(tab.id)) return pending.get(tab.id).promise;
      if (pending.size >= MAX_TABS) return Promise.resolve(result('deferred', 'recovery_limit'));
      const entry = { tabId: tab.id, invalidated: false, promise: null };
      pending.set(tab.id, entry);
      entry.promise = run(entry, tab).catch(() => result('failed', 'observer_unavailable'))
        .finally(() => { if (pending.get(tab.id) === entry) pending.delete(tab.id); });
      return entry.promise;
    }

    function invalidate(tabId, removed = false) {
      const entry = pending.get(tabId);
      if (entry) entry.invalidated = true;
      if (removed) attemptedAt.delete(tabId);
    }

    return { ensure, invalidate };
  }

  return { MAX_TABS, COOLDOWN_MS, FILES, createRecovery };
});
