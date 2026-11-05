/* SPDX-License-Identifier: AGPL-3.0-only */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MoriMonitoringContract = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const CAPABILITIES = Object.freeze(['scope-observation-v2', 'view-observation-v1', 'observation-health-v2']);
  const SCOPE_FIELDS = Object.freeze(['kind', 'viewEpoch', 'bindingEpoch', 'samplingEpoch', 'workerEpoch', 'leaseId', 'documentId', 'startUnobserved']);
  const REASONS = Object.freeze(['storage_failed', 'data_invalid', 'authentication_failed', 'schema_invalid',
    'paused', 'unpaired', 'disconnected', 'permission_denied', 'discarded', 'frozen', 'initializing', 'loading',
    'navigation_pending', 'unsupported_route', 'unsupported_layout', 'observer_version', 'peer_unsupported',
    'extension_limit', 'extension_record_limit', 'desktop_capacity', 'recovery_limit', 'session_limit',
    'receipt_limit', 'outbox_full', 'capacity_unclassified', 'conversation_id_pending', 'scope_unconfirmed',
    'ambiguous_scope', 'dom_unknown', 'observation_rejected', 'lease_pending', 'observer_unavailable',
    'initialization_unconfirmed', 'retry_wait', 'retry_unavailable', 'observation_pending', 'delivery_pending',
    'observation_expired', 'unclassified']);
  const GAP_REASONS = Object.freeze(['start_unobserved', 'sampling_gap', 'scope_lost']);
  const REASON_LABELS = Object.freeze({ storage_failed: '観測の保存に失敗', data_invalid: '保存データを確認できません',
    authentication_failed: '接続の認証を確認', schema_invalid: '観測形式を確認', paused: '監視を停止中', unpaired: 'Chromeの登録待ち',
    disconnected: '本体への再接続待ち', permission_denied: 'サイトへのアクセス権限を確認', discarded: 'タブの再開待ち', frozen: '休止タブの再開待ち',
    initializing: '初期化中', loading: 'ページ読込中', navigation_pending: '会話切替を確認中', unsupported_route: 'このページは対象外',
    unsupported_layout: 'この画面構造には未対応', observer_version: 'ページの監視プログラムを更新待ち', peer_unsupported: '接続先がこの監視方式に未対応',
    extension_limit: 'このChromeの20タブ上限', extension_record_limit: 'このChromeの保存記録200件の上限',
    desktop_capacity: '本体の全ブラウザ合計20タブ上限', recovery_limit: '復旧試行枠の解放待ち', session_limit: '本体の保存記録200件の上限',
    receipt_limit: '通知の保存上限', outbox_full: '未送信通知の保存上限', capacity_unclassified: '容量不足の種類を確認中',
    conversation_id_pending: '会話IDと表示領域の確認待ち', scope_unconfirmed: '表示領域の所属を確認できません', ambiguous_scope: '表示領域の候補が複数あります',
    dom_unknown: 'ページの生成状態を判定できません', observation_rejected: '観測元の再確認待ち', lease_pending: 'ページ監視の再許可待ち',
    observer_unavailable: 'ページ監視の応答待ち', initialization_unconfirmed: '監視の初期化を確認中', retry_wait: '自動再試行を待機中',
    retry_unavailable: '自動再試行を準備できません', observation_pending: '新しい観測を待機中', delivery_pending: '本体の保存確認待ち',
    observation_expired: '観測の更新期限切れ', observer_queue_full: '拡張機能の観測処理が混雑', unclassified: '保留の原因を確認中' });
  const SAMPLE_MS = 10000, MAX_SAMPLE_GAP_MS = 15000, PROOF_MS = 30000;
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const id = v => typeof v === 'string' && ID.test(v);
  const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
  function validScope(v) {
    return keys(v, SCOPE_FIELDS) && Object.keys(v).length === SCOPE_FIELDS.length
      && ['view', 'conversation'].includes(v.kind) && typeof v.startUnobserved === 'boolean'
      && SCOPE_FIELDS.filter(k => !['kind', 'startUnobserved'].includes(k)).every(k => id(v[k]));
  }
  function scopeKey(v) { return JSON.stringify(SCOPE_FIELDS.map(k => v?.[k])); }
  function scopeOwnerKey(v) { return JSON.stringify(SCOPE_FIELDS.filter(k => k !== 'startUnobserved').map(k => v?.[k])); }
  function supports(peer, event) {
    return event.type !== 'scope.event' || (peer?.capabilities?.includes(CAPABILITIES[0])
      && (event.scope?.kind !== 'view' || peer.capabilities.includes(CAPABILITIES[1])));
  }
  function primaryReason(raw, { owner, resource, connected = true, enabled = true, paired = true,
    fault = null, bindingReason = null } = {}) {
    if (['storage_failed', 'local_data_invalid', 'authentication_failed', 'invalid_schema'].includes(raw)) fault ||= raw;
    if (fault) return ({ local_data_invalid: 'data_invalid', authentication_failed: 'authentication_failed',
      invalid_schema: 'schema_invalid' })[fault] || 'storage_failed';
    if (!enabled) return 'paused';
    if (!paired) return 'unpaired';
    if (connected === false) return 'disconnected';
    if (raw === 'capacity') return owner === 'coordinator' && resource === 'active_tabs' ? 'extension_limit'
      : owner === 'coordinator' && resource === 'session_records' ? 'extension_record_limit' : 'capacity_unclassified';
    if (raw === 'active_session_limit') return 'desktop_capacity';
    if (raw === 'binding_unconfirmed') return REASONS.includes(bindingReason) ? bindingReason : 'scope_unconfirmed';
    if (REASONS.includes(raw)) return raw;
    return ({ local_data_invalid: 'data_invalid', permission_required: 'permission_denied',
      tab_loading: 'loading', tab_discarded: 'discarded', tab_frozen: 'frozen', navigation_changed: 'navigation_pending',
      old_document: 'navigation_pending', route_dom_mismatch: 'navigation_pending',
      lease_invalid: 'lease_pending', lease_expired: 'lease_pending', attempt_expired: 'lease_pending',
      initialization_failed: 'initialization_unconfirmed', registration_failed: 'observer_unavailable',
      // Keep the negotiated health-v2 reason vocabulary unchanged. The local
      // options diagnostic can still explain queue pressure more precisely.
      observer_queue_full: 'observer_unavailable',
      injection_failed: 'observer_unavailable', scripting_unavailable: 'peer_unsupported',
      recovery_timeout: 'observer_unavailable', recovery_failed: 'observer_unavailable',
      tab_unavailable: 'observer_unavailable', probe_timeout: 'observer_unavailable', worker_unavailable: 'observer_unavailable',
      recovery_cooldown: 'retry_wait', alarm_failed: 'retry_unavailable',
      old_observation: 'observation_pending', duplicate_observation: 'observation_pending', ignored_order: 'observation_pending',
      ack_unavailable: 'delivery_pending', observation_failed: 'delivery_pending',
      invalid_sender: 'observation_rejected', invalid_observation: 'observation_rejected', invalid_schema: 'schema_invalid',
      connection_failed: 'disconnected', desktop_offline: 'disconnected', connection_closed: 'disconnected',
      heartbeat_timeout: 'disconnected' })[raw] || (raw === null || raw === undefined ? 'delivery_pending' : 'unclassified');
  }
  function legacyReason(reason) {
    if (['paused', 'loading', 'discarded', 'frozen', 'permission_denied'].includes(reason)) return reason;
    if (['conversation_id_pending', 'scope_unconfirmed', 'ambiguous_scope', 'navigation_pending'].includes(reason)) return 'unconfirmed';
    if (['unsupported_layout', 'unsupported_route'].includes(reason)) return 'unsupported';
    if (['extension_limit', 'desktop_capacity'].includes(reason)) return 'over_limit';
    if (['delivery_pending', 'lease_pending', 'observation_pending', 'retry_wait', 'observation_expired'].includes(reason)) return 'checking';
    return 'unavailable';
  }
  // Select only one oldest record per series. An unsupported/temporarily
  // blocked series cannot prevent a different compatible series progressing.
  function selectDeliverable(events, peer, blocked = new Set(), predicate = () => true) {
    const seen = new Set();
    for (const e of events) {
      const key = `${e.type}/${e.browserRunId}/${e.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!blocked.has(key) && supports(peer, e) && predicate(e)) return e;
    }
    return null;
  }
  return { CAPABILITIES, SCOPE_FIELDS, REASONS, REASON_LABELS, GAP_REASONS, SAMPLE_MS, MAX_SAMPLE_GAP_MS, PROOF_MS,
    validScope, scopeKey, scopeOwnerKey, supports, primaryReason, legacyReason, selectDeliverable, id, keys };
});
