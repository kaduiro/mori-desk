/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./provider-utils') : root.MoriProviderUtils,
    typeof module === 'object' && module.exports ? require('./monitoring-contract') : root.MoriMonitoringContract);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriRestartHealth = api;
})(globalThis, function (utils, contract) {
  'use strict';
  const CAPABILITY = 'restart-health-v1';
  const REASONS = Object.freeze(['checking', 'unconfirmed', 'loading', 'discarded', 'frozen',
    'permission_denied', 'paused', 'unsupported', 'over_limit', 'unavailable']);
  const PROVIDERS = Object.freeze(['chatgpt', 'claude']);
  function unknownProviders() {
    return PROVIDERS.map(provider => ({ provider, inventory: 'unknown', discovered: null, eligible: null,
      admitted: null, fresh: null, unmonitored: null, reasons: null }));
  }
  function classify(tab, result, enabled) {
    if (!enabled) return 'paused';
    if (tab.discarded) return 'discarded';
    if (tab.frozen) return 'frozen';
    if (tab.status === 'loading') return 'loading';
    if (result?.overLimit) return 'over_limit';
    if (result?.ok) return 'checking';
    const reasons = { binding_unconfirmed: 'unconfirmed', tab_loading: 'loading', tab_discarded: 'discarded',
      tab_frozen: 'frozen', permission_required: 'permission_denied', paused: 'paused',
      unsupported_route: 'unsupported', recovery_limit: 'over_limit', capacity: 'over_limit',
      probe_timeout: 'unavailable', observer_unavailable: 'unavailable', injection_failed: 'unavailable',
      scripting_unavailable: 'unavailable', recovery_timeout: 'unavailable' };
    return reasons[result?.reason] || 'checking';
  }
  function summarize(tabs, results, { enabled = true, access = { chatgpt: true, claude: true } } = {}) {
    if (!Array.isArray(tabs) || tabs.length > 100000) return unknownProviders();
    const rows = PROVIDERS.map(provider => ({ provider, inventory: 'known', discovered: 0, eligible: 0,
      admitted: 0, fresh: 0, unmonitored: 0, reasons: Object.fromEntries(REASONS.map(key => [key, 0])) }));
    let selected = 0;
    for (const tab of tabs) {
      const provider = utils.routeForUrl(tab?.url)?.provider;
      const row = rows.find(value => value.provider === provider);
      if (!row) continue;
      const candidate = results?.get(tab.id);
      const eligible = !candidate?.overLimit && selected < 20;
      const result = eligible ? candidate : { overLimit: true };
      row.discovered++;
      if (eligible) { row.eligible++; selected++; }
      if (eligible && result?.ok) row.admitted++;
      // Registration/health cannot prove a new sample on the current transport.
      // W5b's token-bound observation gate is deliberately not inferred here.
      row.reasons[classify(tab, result, enabled)]++;
      row.unmonitored++;
    }
    // A withheld host grant can hide URLs from tabs.query. A visible subset
    // cannot be advertised as a complete zero-tab inventory for that origin.
    return rows.map(row => access[row.provider] === true ? row
      : unknownProviders().find(value => value.provider === row.provider));
  }
  function safePeer(message) {
    if (!Object.hasOwn(message, 'capabilities')) return { capabilities: [], build: null };
    if (!Array.isArray(message.capabilities) || message.capabilities.length > 16
      || new Set(message.capabilities).size !== message.capabilities.length
      || message.capabilities.some(value => typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value))) {
      throw new Error('invalid_capabilities');
    }
    if (!message.capabilities.includes(CAPABILITY)) return { capabilities: [...message.capabilities], build: null };
    const build = message.build;
    if (!build || typeof build !== 'object' || Array.isArray(build)
      || Object.keys(build).some(key => !['desktopVersion', 'buildId', 'observerContract'].includes(key))
      || typeof build.desktopVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/.test(build.desktopVersion)
      || typeof build.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(build.buildId) || build.observerContract !== 1) {
      throw new Error('invalid_build');
    }
    return { capabilities: [...message.capabilities], build: { ...build } };
  }
  function summarizeV2(tabs, results, { enabled = true, access = { chatgpt: true, claude: true },
    evidence = new Map(), context = {} } = {}) {
    if (!Array.isArray(tabs) || tabs.length > 100000) return unknownProviders();
    const rows = PROVIDERS.map(provider => ({ provider, inventory: 'known', discovered: 0, eligible: 0,
      admitted: 0, fresh: 0, unmonitored: 0, reasons: Object.fromEntries(contract.REASONS.map(k => [k, 0])) }));
    let selected = 0;
    for (const tab of tabs) {
      const row = rows.find(r => r.provider === utils.routeForUrl(tab?.url)?.provider);
      if (!row) continue;
      const r = results?.get(tab.id);
      const eligible = !r?.overLimit && selected < 20;
      if (eligible) { row.eligible++; selected++; }
      row.discovered++;
      const admitted = eligible && r?.ok;
      if (admitted) row.admitted++;
      const proof = evidence.get(tab.id);
      if (admitted && proof && enabled && context.connected !== false && !context.fault && access[row.provider] === true) {
        row.fresh++; continue;
      }
      const raw = tab.discarded ? 'discarded' : tab.frozen ? 'frozen' : tab.status === 'loading' ? 'loading'
        : !eligible ? 'capacity' : r?.reason;
      const reason = contract.primaryReason(raw, { ...context, enabled,
        owner: !eligible ? 'coordinator' : r?.owner, resource: !eligible ? 'active_tabs' : r?.resource,
        bindingReason: r?.bindingReason });
      row.reasons[reason]++; row.unmonitored++;
    }
    return rows.map(row => access[row.provider] === true ? row : unknownProviders().find(r => r.provider === row.provider));
  }
  return { CAPABILITY, REASONS, PROVIDERS, unknownProviders, summarize, summarizeV2, safePeer };
});
