/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = path.join(__dirname, '../extensions/browser-bridge');
const html = fs.readFileSync(path.join(extension, 'options.html'), 'utf8');

// Execute the shipped options renderer with count-only worker responses.
// This does not validate Chrome permissions, injection, or real provider pages.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
    this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ''; this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('\n'); }
  set innerHTML(_value) { throw new Error('Options diagnostic must not parse HTML'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  fire(type) {
    if (type === 'click' && this.disabled) return;
    return this.listeners.get(type)?.({ preventDefault() {} });
  }
}

function health(overrides = {}) {
  return {
    ok: true, paired: true, enabled: true, connectionState: 'connected', totalTabs: 1, checkedTabs: 1, remainingTabs: 0,
    ...overrides,
    counts: { needsReload: 0, unsupportedRoute: 0, unknown: 0, idle: 1, running: 0, settled: 0, ...overrides.counts },
    observationDelivery: { accepted: 1, rejected: 0, unconfirmed: 0, runningAccepted: 0, reasons: {}, ...overrides.observationDelivery },
    observerRecovery: { attempted: 0, recovered: 0, deferred: 0, failed: 0, reasons: {}, ...overrides.observerRecovery },
  };
}

async function fixture(initialHealth = health()) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const calls = [];
  let nextHealth = initialHealth;
  const status = { ok: true, paired: true, enabled: true, connection: { state: 'connected' }, diagnostic: null,
    trackedTabs: 1, running: 0, pending: 0, version: '0.1.6', extensionId: 'test-extension' };
  let poll;
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(elements.has(id), `Unknown options element: ${id}`); return elements.get(id); },
      createElement: tag => new Element(tag),
    },
    chrome: { runtime: { async sendMessage(message) {
      calls.push(structuredClone(message));
      if (message.type === 'mori.options.status') return status;
      if (message.type === 'mori.options.health') return typeof nextHealth === 'function' ? nextHealth() : nextHealth;
      return { ok: true };
    } } },
    confirm: () => false, setInterval(callback) { poll = callback; },
  });
  vm.runInContext(fs.readFileSync(path.join(extension, 'options.js'), 'utf8'), context, { filename: 'options.js' });
  async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
  await settle();
  return {
    elements, calls, status, settle,
    setHealth(value) { nextHealth = value; },
    async click(id) { elements.get(id).fire('click'); await settle(); },
    async submit() { elements.get('pair-form').fire('submit'); await settle(); },
    async poll() { poll(); await settle(); },
    get diagnostic() { return elements.get('tab-health').textContent; },
  };
}

test('options distinguishes desktop communication from recovered page monitoring and keeps delivery evidence separate', async () => {
  const f = await fixture(health({ observerRecovery: { attempted: 1, recovered: 1 } }));
  assert.match(html, /id="status-heading">本体との接続/);
  assert.match(html, /id="check-tabs"[^>]*>タブの監視を確認・復旧/);
  assert.match(html, /ページの再読み込みや、入力・送信は行いません/);
  assert.match(f.elements.get('connection-detail').textContent, /通信は接続済み/);
  assert.match(f.elements.get('connection-detail').textContent, /ページ内の監視/);
  await f.click('check-tabs');
  assert.match(f.diagnostic, /ページ内の監視：復旧 1 件・待機 0 件・復旧できず 0 件/);
  assert.match(f.diagnostic, /自動復旧を試したタブ 1 件/);
  assert.match(f.diagnostic, /対象タブ 1 件中 1 件/);
  assert.match(f.diagnostic, /拡張機能が観測を受け付けたタブ 1 件/);
  assert.match(f.diagnostic, /MORI Desk への反映は、本体の/);
  assert.doesNotMatch(f.diagnostic, /F5|再読み込み/);
  assert.deepEqual(f.calls.filter(call => call.type !== 'mori.options.status'), [{ type: 'mori.options.health' }]);
  assert.equal(f.elements.get('action-result').dataset.error, 'false');
});

test('permission and unavailable recovery capabilities have actionable guidance without directing a page reload', async () => {
  for (const [reason, expected] of [['permission_required', /アクセスが許可されていません/],
    ['scripting_unavailable', /復旧する準備ができていません/]]) {
    const f = await fixture(health({ counts: { needsReload: 1, idle: 0 },
      observationDelivery: { accepted: 0 }, observerRecovery: { attempted: 1, failed: 1, reasons: { [reason]: 1 } } }));
    await f.click('check-tabs');
    assert.match(f.diagnostic, expected, reason);
    assert.match(f.diagnostic, /既存タブの監視を復旧/, reason);
    assert.match(f.diagnostic, /観測の受付結果もまだ届いていません/, reason);
    assert.doesNotMatch(f.diagnostic, /F5|再読み込み|scripting/, reason);
  }
});

test('zero visible tabs and site access counts do not imply there are no AI tabs or that a responding observer is blocked', async () => {
  const access = { granted: 0, missing: 1, unknown: 1 };
  const f = await fixture(health({ totalTabs: 0, checkedTabs: 0, counts: { idle: 0 },
    observationDelivery: { accepted: 0 }, siteAccess: access }));
  await f.click('check-tabs');
  assert.match(f.diagnostic, /確認できる対象タブがありません/);
  assert.match(f.diagnostic, /この Chrome プロファイル/);
  assert.match(f.diagnostic, /サイトへのアクセスも確認/);
  assert.match(f.diagnostic, /2 サイトへの常時アクセス：許可を確認 0 件・設定の確認が必要 1 件・取得できず 1 件/);
  assert.doesNotMatch(f.diagnostic, /F5|復旧できず/);
  f.setHealth(health({ siteAccess: { granted: 0, missing: 2, unknown: 0 } }));
  await f.click('check-tabs');
  assert.match(f.diagnostic, /拡張機能が観測を受け付けたタブ 1 件/);
  assert.match(f.diagnostic, /今回、復旧が必要なタブは見つかりませんでした/);
  assert.doesNotMatch(f.diagnostic, /復旧できず|F5/);
});

test('paused, resting, loading and temporary recovery waits have distinct explanations and do not request F5', async () => {
  const cases = {
    paused: /監視を一時停止/, unpaired: /接続コードで登録/, storage_failed: /保存先の問題/,
    tab_loading: /ページの読み込み中/, tab_discarded: /Chrome が休止させた/,
    tab_frozen: /Chrome が動作を止めている/, unsupported_route: /対象外のページ/,
    recovery_cooldown: /直前の復旧処理/, recovery_limit: /タブ数の上限/,
    probe_timeout: /監視の応答を待っています/, navigation_changed: /会話やページの切り替え中/,
  };
  for (const [reason, expected] of Object.entries(cases)) {
    const f = await fixture(health({ paired: reason !== 'unpaired', enabled: reason !== 'paused',
      counts: { idle: 0, unknown: 1 }, observationDelivery: { accepted: 0 },
      observerRecovery: { deferred: 1, reasons: { [reason]: 1 } } }));
    if (reason === 'storage_failed') {
      f.status.ok = false;
      f.status.connection = { state: 'blocked', code: 'storage_failed' };
      f.status.diagnostic = 'storage_failed';
      await f.poll();
      assert.equal(f.elements.get('check-tabs').disabled, false);
      for (const id of ['retry', 'pause', 'unpair', 'pair-button']) assert.equal(f.elements.get(id).disabled, true, id);
      await f.click('retry');
      await f.click('pause');
      assert.equal(f.calls.some(call => ['mori.options.retry', 'mori.options.enabled'].includes(call.type)), false);
    }
    await f.click('check-tabs');
    assert.equal(f.calls.filter(call => call.type === 'mori.options.health').length, 1, reason);
    assert.match(f.diagnostic, /復旧 0 件・待機 1 件・復旧できず 0 件/, reason);
    assert.match(f.diagnostic, expected, reason);
    assert.doesNotMatch(f.diagnostic, /F5|再読み込み/, reason);
  }
});

test('failed repair offers reload only as a last resort after generation and draft protection', async () => {
  for (const reason of ['injection_failed', 'recovery_timeout', 'observer_unavailable']) {
    const f = await fixture(health({ counts: { needsReload: 1, idle: 0 }, observationDelivery: { accepted: 0 },
      observerRecovery: { attempted: 1, failed: 1, reasons: { [reason]: 1 } } }));
    await f.click('check-tabs');
    assert.match(f.diagnostic, /復旧できず 1 件/, reason);
    assert.match(f.diagnostic, /最後の手段として、AI タブを再読み込み（F5）/, reason);
    assert.match(f.diagnostic, /回答の生成が終わるのを待ち、未送信の文章を別の場所に控えてから/, reason);
    assert.deepEqual(f.calls.filter(call => call.type !== 'mori.options.status'), [{ type: 'mori.options.health' }]);
  }
});

test('older count-only responses remain readable and needsReload alone never becomes a blanket reload instruction', async () => {
  const old = health({ counts: { needsReload: 1, idle: 0 }, observationDelivery: { accepted: 0 } });
  delete old.observerRecovery;
  const f = await fixture(old);
  await f.click('check-tabs');
  assert.match(f.diagnostic, /1 件でページ内の監視の応答を確認できていません/);
  assert.match(f.diagnostic, /自動復旧の結果は届いていません/);
  assert.match(f.diagnostic, /拡張機能が最新か確認/);
  assert.doesNotMatch(f.diagnostic, /F5|再読み込み/);
  f.setHealth(health({ counts: { needsReload: 1, idle: 0 }, observationDelivery: { accepted: 0 } }));
  await f.click('check-tabs');
  assert.match(f.diagnostic, /今回は自動復旧を行っていません/);
  assert.doesNotMatch(f.diagnostic, /復旧が必要なタブは見つかりません|F5|再読み込み/);
});

test('diagnostic reason rendering never exposes raw unknown text or interprets it as markup', async () => {
  const privateReason = '<img src="https://private.invalid/PRIVATE_TITLE" onerror="unexpected()">';
  const f = await fixture(health({ observerRecovery: { failed: 1, reasons: { [privateReason]: 1, ['__proto__']: 1 } },
    observationDelivery: { accepted: 0, rejected: 1, reasons: { [privateReason]: 1, ack_unavailable: 1 } } }));
  await f.click('check-tabs');
  assert.doesNotMatch(f.diagnostic, /PRIVATE_TITLE|private\.invalid|onerror|\[object Object\]/);
  assert.match(f.diagnostic, /復旧結果を確認できませんでした/);
  assert.match(f.diagnostic, /観測の受付結果が返りませんでした/);
  assert.doesNotMatch(f.diagnostic, /F5|再読み込み/);
});

test('a pending diagnostic cannot be duplicated and retry or pairing does not claim page reload is required', async () => {
  const f = await fixture();
  let finish;
  f.setHealth(() => new Promise(resolve => { finish = resolve; }));
  await f.click('check-tabs');
  assert.equal(f.elements.get('check-tabs').disabled, true);
  assert.match(f.elements.get('action-result').textContent, /必要な復旧を試しています/);
  await f.click('check-tabs');
  assert.equal(f.calls.filter(call => call.type === 'mori.options.health').length, 1);
  finish(health()); await f.settle();
  assert.equal(f.elements.get('check-tabs').disabled, false);
  await f.click('retry');
  assert.match(f.elements.get('action-result').textContent, /本体との接続状態/);
  f.elements.get('pair-code').value = 'mori1:test-code';
  await f.submit();
  assert.equal(f.elements.get('pair-code').value, '');
  assert.match(f.elements.get('action-result').textContent, /タブの監視を確認・復旧/);
  assert.doesNotMatch(f.elements.get('action-result').textContent, /F5|再読み込み/);
  await f.poll();
  assert.deepEqual(f.calls.filter(call => call.type !== 'mori.options.status'), [
    { type: 'mori.options.health' }, { type: 'mori.options.retry' }, { type: 'mori.options.pair', code: 'mori1:test-code' },
  ]);
});
