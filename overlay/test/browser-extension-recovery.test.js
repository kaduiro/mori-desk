const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const utils = require('../extensions/browser-bridge/provider-utils');
const recoveryApi = require('../extensions/browser-bridge/observer-recovery');

function fixture() {
  const tabs = new Map([[7, { id: 7, url: 'https://chatgpt.com/c/test', status: 'complete',
    documentId: 'document-a', pageInstanceId: 'page-a', listener: 'missing' }]]);
  const calls = [];
  let block = null, time = 1000, bundleNumber = 0;
  let afterSnapshot = () => {}, beforeBundle = () => {}, afterBundle = () => {}, duringProbe = () => {};
  const chrome = {
    runtime: { getManifest: () => ({ version: '0.1.6' }) },
    permissions: { contains: async () => true },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('PRIVATE_TAB_URL'); return { ...tabs.get(id) }; },
      sendMessage: async (id, message, options) => {
        const tab = tabs.get(id);
        calls.push({ type: 'message', message, options });
        if (!tab || (options.documentId && options.documentId !== tab.documentId)) throw new Error('PRIVATE_MISSING_DOCUMENT');
        if (message.type === 'mori.focus.check') {
          if (tab.focusError) throw new Error('PRIVATE_RUNTIME_ERROR https://chatgpt.com/c/private');
          return { ok: message.pageInstanceId === tab.pageInstanceId, pageInstanceId: tab.pageInstanceId,
            conversationRef: utils.routeForUrl(tab.url)?.conversationRef };
        }
        await duringProbe(tab);
        if (tab.listener === 'timeout') throw new Error('tab_unavailable');
        if (tab.listener === 'missing') throw new Error('PRIVATE_NO_RECEIVER');
        if (tab.listener === 'invalid') return { ok: false, data: 'PRIVATE_INVALID_RESPONSE' };
        if (tab.listener === 'legacy') return { ok: true };
        return { ok: true, v: 1, observerVersion: '0.1.6', pageInstanceId: tab.pageInstanceId,
          route: utils.routeForUrl(tab.url) };
      },
    },
    scripting: { executeScript: async options => {
      calls.push({ type: options.files ? 'bundle' : 'snapshot', options });
      const tab = tabs.get(options.target.tabId);
      assert.equal(options.world, 'ISOLATED');
      assert.equal(options.injectImmediately, true);
      assert.equal(options.target.allFrames, undefined);
      if (tab.injectionError) throw new Error('PRIVATE_PERMISSION_ERROR https://chatgpt.com/c/private');
      if (options.files) {
        await beforeBundle(tab);
        assert.equal(options.target.frameIds, undefined);
        assert.deepEqual(options.files, [...recoveryApi.FILES]);
        if (options.target.documentIds[0] !== tab.documentId) throw new Error('PRIVATE_WRONG_DOCUMENT');
        if (!tab.noop) {
          tab.listener = 'modern'; tab.pageInstanceId = `recovered-${++bundleNumber}`;
        }
        await afterBundle(tab);
        return [{ frameId: 0, documentId: options.target.documentIds[0] }];
      }
      assert.deepEqual(options.target.frameIds, [0]);
      assert.equal(options.target.documentIds, undefined);
      // Execute the actual serialized preflight against an isolated read-only
      // fixture; it must not depend on worker globals or inspect page content.
      const context = vm.createContext({ location: new URL(tab.url), document: {
        readyState: 'complete', visibilityState: 'visible', prerendering: !!tab.prerendering,
        get body() { throw new Error('preflight must not read page content'); },
      } });
      const response = { frameId: 0, documentId: tab.documentId,
        result: vm.runInContext(`(${options.func.toString()})()`, context) };
      await afterSnapshot(tab);
      return [response];
    } },
  };
  const manager = recoveryApi.createRecovery({ chrome, within: value => Promise.resolve(value),
    getBlockReason: () => block, now: () => time });
  return { tabs, calls, chrome, manager, ensure: (id = 7) => manager.ensure({ ...tabs.get(id) }),
    block: reason => { block = reason; }, advance: ms => { time += ms; },
    afterSnapshot: callback => { afterSnapshot = callback; }, beforeBundle: callback => { beforeBundle = callback; },
    afterBundle: callback => { afterBundle = callback; }, duringProbe: callback => { duringProbe = callback; } };
}

test('missing or malformed observers recover through a fixed top-frame probe and exact-document packaged bundle', async () => {
  for (const listener of ['missing', 'invalid']) {
    const f = fixture(); f.tabs.get(7).listener = listener;
    const result = await f.ensure();
    assert.equal(result.disposition, 'recovered');
    assert.equal(result.attempted, true);
    assert.equal(result.documentId, 'document-a');
    assert.equal(f.calls.filter(call => call.type === 'bundle').length, 1);
    assert.deepEqual(f.calls.find(call => call.type === 'bundle').options.target,
      { tabId: 7, documentIds: ['document-a'] });
    assert.ok(f.calls.some(call => call.type === 'message' && call.options.documentId === 'document-a'));
    assert.equal(f.calls.filter(call => call.type === 'snapshot').length, 2);
  }
});

test('healthy current and legacy observers are not injected, and liveness timeouts remain deferred', async () => {
  for (const listener of ['modern', 'legacy', 'timeout']) {
    const f = fixture(); f.tabs.get(7).listener = listener;
    const result = await f.ensure();
    assert.equal(result.disposition, listener === 'timeout' ? 'deferred' : 'healthy');
    assert.equal(result.reason, listener === 'timeout' ? 'probe_timeout' : null);
    assert.equal(result.attempted, false);
    assert.equal(f.calls.filter(call => call.type !== 'message').length, 0);
  }
});

test('paused, unpaired, fail-closed, loading, discarded, frozen and unsupported pages are never injected', async () => {
  for (const reason of ['paused', 'unpaired', 'storage_failed']) {
    const f = fixture(); f.block(reason);
    const result = await f.ensure();
    assert.equal(result.reason, reason);
    assert.equal(result.disposition, 'deferred');
    assert.equal(f.calls.some(call => call.type === 'bundle' || call.type === 'snapshot'), false);
  }
  for (const [patch, reason] of [[{ status: 'loading' }, 'tab_loading'], [{ discarded: true }, 'tab_discarded'],
    [{ frozen: true }, 'tab_frozen'], [{ url: 'https://chatgpt.com/settings' }, 'unsupported_route'],
    [{ url: 'https://unrelated.test/c/test' }, 'unsupported_route']]) {
    const f = fixture(); Object.assign(f.tabs.get(7), patch);
    assert.equal((await f.ensure()).reason, reason);
    assert.equal(f.calls.length, 0);
  }
});

test('overlapping retries coalesce per tab and repeated failures obey a 30-second cooldown', async () => {
  const f = fixture();
  let release;
  f.duringProbe(() => new Promise(resolve => { release = resolve; }));
  const first = f.ensure(); const second = f.ensure();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  f.duringProbe(() => {}); release();
  assert.equal((await first).disposition, 'recovered');
  assert.equal((await second).disposition, 'recovered');
  f.tabs.get(7).listener = 'missing'; f.tabs.get(7).injectionError = true;
  assert.equal((await f.ensure()).reason, 'recovery_cooldown');
  f.advance(recoveryApi.COOLDOWN_MS);
  assert.equal((await f.ensure()).reason, 'injection_failed');
  const attempted = f.calls.filter(call => call.type === 'snapshot').length;
  assert.equal((await f.ensure()).reason, 'recovery_cooldown');
  assert.equal(f.calls.filter(call => call.type === 'snapshot').length, attempted);
});

test('automatic recovery has at most 20 pending tabs and 20 attempts per cooldown window', async () => {
  const f = fixture(); f.tabs.clear();
  const releases = [];
  f.duringProbe(() => new Promise(resolve => releases.push(resolve)));
  for (let id = 0; id < 21; id++) f.tabs.set(id, { id, url: `https://chatgpt.com/c/test-${id}`,
    status: 'complete', documentId: `document-${id}`, listener: 'missing' });
  const running = Array.from({ length: 20 }, (_, id) => f.ensure(id));
  assert.equal((await f.ensure(20)).reason, 'recovery_limit');
  await new Promise(resolve => setImmediate(resolve));
  f.duringProbe(() => {}); releases.forEach(release => release());
  assert.ok((await Promise.all(running)).every(result => result.disposition === 'recovered'));
  assert.equal((await f.ensure(20)).reason, 'recovery_limit');
  assert.equal(f.calls.filter(call => call.type === 'bundle').length, 20);
  f.advance(recoveryApi.COOLDOWN_MS);
  assert.equal((await f.ensure(20)).disposition, 'recovered');
});

test('pause, unpair, fail-closed and route changes during preflight stop before bundle injection', async () => {
  for (const reason of ['paused', 'unpaired', 'storage_failed', 'navigation_changed']) {
    const f = fixture();
    f.afterSnapshot(tab => {
      if (reason === 'navigation_changed') tab.url = 'https://claude.ai/chat/other';
      else f.block(reason);
    });
    const result = await f.ensure();
    assert.equal(result.disposition, 'deferred');
    assert.equal(result.reason, reason);
    assert.equal(f.calls.some(call => call.type === 'bundle'), false);
  }
});

test('same-URL replacement cannot receive a bundle aimed at the old document or count as recovered', async () => {
  const before = fixture();
  before.beforeBundle(tab => { tab.documentId = 'document-replaced'; });
  assert.notEqual((await before.ensure()).disposition, 'recovered');
  assert.equal(before.tabs.get(7).listener, 'missing');
  assert.deepEqual(before.calls.find(call => call.type === 'bundle').options.target.documentIds, ['document-a']);
  const after = fixture();
  after.afterBundle(tab => { tab.documentId = 'document-replaced'; });
  const changed = await after.ensure();
  assert.equal(changed.reason, 'navigation_changed');
  assert.equal(changed.disposition, 'deferred');
  assert.equal(after.calls.some(call => call.type === 'message' && call.options.documentId), false);
});

test('navigation invalidation and pause after injection cannot report a restored observer', async () => {
  const f = fixture(); f.afterBundle(() => f.manager.invalidate(7));
  assert.equal((await f.ensure()).reason, 'navigation_changed');
  const paused = fixture(); paused.afterBundle(() => paused.block('paused'));
  assert.equal((await paused.ensure()).reason, 'paused');
});

test('withheld persistent permission is not an injection gate; failures and error prose remain fixed categories', async () => {
  const grantedTab = fixture(); grantedTab.chrome.permissions.contains = async () => false;
  assert.equal((await grantedTab.ensure()).disposition, 'recovered');
  const denied = fixture(); denied.chrome.permissions.contains = async () => false;
  denied.tabs.get(7).injectionError = true;
  const failed = await denied.ensure();
  assert.equal(failed.reason, 'permission_required');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_|https:|documentId|pageInstanceId/);
  const changed = fixture(); changed.tabs.get(7).listener = 'modern'; changed.tabs.get(7).focusError = true;
  const unavailable = await changed.ensure();
  assert.equal(unavailable.reason, 'navigation_changed');
  assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_|https:/);
  assert.equal(changed.calls.some(call => call.type === 'bundle'), false);
});

test('missing scripting support and a bundle that cannot restore messaging are explicit failures', async () => {
  const absent = fixture(); delete absent.chrome.scripting;
  assert.equal((await absent.ensure()).reason, 'scripting_unavailable');
  const noop = fixture(); noop.tabs.get(7).noop = true;
  const result = await noop.ensure();
  assert.equal(result.disposition, 'failed');
  assert.equal(result.reason, 'observer_unavailable');
});
