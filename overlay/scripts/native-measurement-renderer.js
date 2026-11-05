/* SPDX-License-Identifier: AGPL-3.0-only */
'use strict';
const byId = id => document.getElementById(id);
const REASONS = Object.freeze({ none: '利用できます', not_started: '未起動', starting: '起動準備中',
  expired: '計測時間の上限', overflow: '計測容量の上限', clock_invalid: '時計を取得できません',
  clock_discontinuity: '時計の連続性が不明', disposed: '終了済み', directory_unavailable: '専用保存先を利用できません',
  secure_storage_unavailable: '安全な暗号化を利用できません', ports_unavailable: '専用接続口を利用できません',
  browser_store_unreadable: '観測保存先を読み取れません', credential_store_unreadable: '接続情報を読み取れません',
  bridge_unavailable: '接続を開始できません', pairing_unavailable: '接続コードを発行できません',
  clipboard_unavailable: 'クリップボードへ書き込めません', caller_rejected: '操作元を確認できません',
  state_unavailable: '状態を確認できません', export_failed: '保存できません', product_ui_unavailable: '製品UIを開けません' });
const reasonLabel = reason => REASONS[reason] || REASONS.state_unavailable;
const hashLabel = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '確認不能（旧形式または欠測）';
let displayedGeneration = null;
function disablePairing() { byId('pair').disabled = true; byId('copy').disabled = true; }
async function refresh() {
  try {
    const state = await window.moriMeasurement.status();
    byId('status').textContent = state.ok ? state.capture?.phase === 'waiting'
      ? '接続待ちです。認証が完了すると計測を開始します。'
      : state.capture?.phase === 'recording' ? '計測中です。上限は最初の認証完了から10分です。'
      : '計測段階を確認できません。結果は計測不足として扱います。'
      : state.category === 'expired' ? '計測時間の上限に達しました。新しい計測にはコレクターの再起動と対象タブの再読み込みが必要です。'
      : state.category === 'overflow' ? '計測容量の上限に達しました。結果は計測不足として保存します。'
      : '現在の計測は利用できません。結果は計測不足として保存します。';
    const counts = state.counts || {};
    byId('counts').textContent = `接続 累計 ${Number(counts.connections) || 0}・現在 ${Number(counts.activeConnections) || 0} / イベント ${Number(counts.events) || 0} / 時計照合 ${Number(counts.pings) || 0}`;
    const runtime = state.runtime || {}, pairing = state.pairing || {};
    const generation = Number.isSafeInteger(runtime.runGeneration) ? runtime.runGeneration : null;
    if (displayedGeneration !== generation || state.ok !== true) byId('code').textContent = '';
    displayedGeneration = generation;
    byId('run').textContent = generation === null ? '確認不能（旧形式または欠測）' : String(generation);
    byId('fingerprint').textContent = hashLabel(runtime.componentFingerprint);
    byId('kit-fingerprint').textContent = hashLabel(runtime.kitSourceFingerprint);
    byId('build-fingerprint').textContent = hashLabel(runtime.buildFingerprint);
    const phase = state.capture?.phase;
    const remaining = state.capture?.remainingMs;
    byId('phase').textContent = phase === 'waiting' ? '認証待ち' : phase === 'recording' ? '計測中' : '未確認';
    byId('remaining').textContent = phase === 'waiting' && state.ok ? '認証後から開始'
      : Number.isFinite(remaining) && remaining >= 0 ? `${Math.ceil(remaining / 1000)} 秒` : '確認不能';
    byId('connection').textContent = ({ authenticated: '認証済み接続あり', unauthenticated: '未認証接続のみ', disconnected: '接続なし' })[state.connection?.state] || '確認不能';
    byId('pair').disabled = state.ok !== true || pairing.canIssue !== true;
    byId('copy').disabled = state.ok !== true || pairing.canCopy !== true;
    byId('pair-reason').textContent = `発行・コピー: ${reasonLabel(pairing.reason)}`;
  } catch (_) {
    disablePairing(); byId('status').textContent = '状態を読み取れませんでした。';
    byId('pair-reason').textContent = reasonLabel('state_unavailable');
  }
}
byId('pair').addEventListener('click', async () => {
  try { const r = await window.moriMeasurement.pair(); byId('code').textContent = r.ok && typeof r.code === 'string' ? r.code : reasonLabel(r.reason); }
  catch (_) { byId('code').textContent = reasonLabel('state_unavailable'); }
});
byId('copy').addEventListener('click', async () => {
  try { const r = await window.moriMeasurement.copyPair(); byId('code').textContent = r.ok ? '新しい接続コードをコピーしました。' : reasonLabel(r.reason); }
  catch (_) { byId('code').textContent = reasonLabel('state_unavailable'); }
});
byId('open-product-ui').addEventListener('click', async () => {
  try { const r = await window.moriMeasurement.openProductUI(); byId('product-result').textContent = r.ok ? '隔離製品UIを開きました。表示の受入確認は未完了です。' : reasonLabel(r.reason); }
  catch (_) { byId('product-result').textContent = reasonLabel('product_ui_unavailable'); }
});
byId('export').addEventListener('click', async () => {
  try { const r = await window.moriMeasurement.export(); byId('report').textContent = r.ok ? r.path : '保存できませんでした。'; }
  catch (_) { byId('report').textContent = '保存できませんでした。'; }
});
disablePairing(); void refresh(); setInterval(refresh, 1000);
