/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let snapshot = null;
  let busy = false;
  const states = { loading: '読み込み中', unpaired: '未接続', pairing: '接続を確認中', connecting: '接続中',
    connected: '接続済み', disconnected: 'デスクトップ待ち', paused: '監視を停止中', error: '保存データの確認が必要' };
  const errors = {
    invalid_pairing_code: '接続コードの形式を確認してください。MORI Desk で新しく発行できます。',
    pairing_expired: '接続コードの有効期限が切れています。MORI Desk で再発行してください。',
    pairing_not_found: '接続コードを確認できませんでした。MORI Desk で再発行してください。',
    unpair_first: '別の MORI Desk に接続する前に、現在の接続を解除してください。',
    identity_mismatch: '接続先の MORI Desk を確認できませんでした。接続コードを再発行してください。',
    authentication_failed: '接続の認証に失敗しました。MORI Desk と拡張機能の登録を確認してください。',
    authentication_timeout: '接続を確認できませんでした。MORI Desk が起動しているか確認してください。',
    unknown_client: 'デスクトップにこの Chrome の登録がありません。接続コードで登録し直してください。',
    connection_failed: 'MORI Desk に接続できません。デスクトップを起動してから再接続してください。',
    desktop_offline: 'MORI Desk の起動を待っています。自動的に再接続します。',
    connection_closed: '接続が切れました。保存した通知を保持して、自動的に再接続します。',
    heartbeat_timeout: '接続を確認できません。MORI Desk の状態を確認して再接続します。',
    outbox_full: '未送信の通知が上限に達しました。MORI Desk に接続するまで新しい記録を保留しています。',
    capacity: '監視できるのは最大 20 タブです。不要な AI タブを閉じてください。',
    unsupported: '一部のページで生成状態を読み取れません。通常のテキスト会話で確認してください。',
    storage_failed: 'データの保存に失敗したため監視を停止しました。空き容量を確認して拡張機能を再読み込みしてください。',
    local_data_invalid: '保存データを読み取れないため監視を停止しました。データを上書きせず、管理者に確認してください。',
    rate_limit: '状態の送信が一時的に制限されました。通知を保持して再接続します。',
    resync_required: '表示を同期し直しています。',
    receipt_limit: 'MORI Desk の通知保存数が上限に達しました。デスクトップ側で通知を整理してください。',
    session_limit: 'MORI Desk のセッション数が上限に達しました。デスクトップ側で不要な行を整理してください。',
    unpaired: 'MORI Desk で接続コードを発行して、この画面で登録してください。',
  };

  function friendly(code) { return errors[code] || '処理を完了できませんでした。MORI Desk と拡張機能のバージョンを確認してください。'; }
  async function send(type, extra = {}) { return chrome.runtime.sendMessage({ type: `mori.options.${type}`, ...extra }); }
  function showResult(text, error = false) {
    $('action-result').textContent = text;
    $('action-result').dataset.error = String(error);
  }
  async function refresh() {
    try {
      snapshot = await send('status');
      if (!snapshot?.connection) return;
      const state = snapshot.connection.state;
      $('connection').textContent = states[state] || '状態を確認中';
      $('connection').dataset.state = state;
      $('connection-detail').textContent = state === 'connected'
        ? 'MORI Desk に接続しています。AI のタブを開いて、通常のテキスト会話で試してください。'
        : state === 'paused' ? '監視を一時停止しています。保存した未送信の通知は保持します。'
          : state === 'unpaired' ? friendly('unpaired')
            : snapshot.connection.code ? friendly(snapshot.connection.code)
              : 'MORI Desk への接続を確認しています。';
      $('tracked').textContent = snapshot.trackedTabs;
      $('running').textContent = snapshot.running;
      $('pending').textContent = snapshot.pending;
      $('pause').textContent = snapshot.enabled ? '監視を一時停止' : '監視を再開';
      $('pause').disabled = busy || !snapshot.paired || !snapshot.ok;
      $('retry').disabled = busy || !snapshot.paired || !snapshot.enabled || !snapshot.ok;
      $('unpair').disabled = busy || !snapshot.paired || !snapshot.ok;
      $('pair-button').disabled = busy || !snapshot.ok;
      $('diagnostic').hidden = !snapshot.diagnostic;
      $('diagnostic').textContent = snapshot.diagnostic ? friendly(snapshot.diagnostic) : '';
      $('version').textContent = `MORI Browser Bridge ${snapshot.version} · ローカル接続`;
      $('extension-id').textContent = snapshot.extensionId;
    } catch (_) {
      $('connection').textContent = '拡張機能を確認してください';
      $('connection-detail').textContent = '設定画面を再読み込みするか、Chrome の拡張機能管理画面でエラーを確認してください。';
    }
  }
  async function action(operation, success) {
    if (busy) return;
    busy = true; await refresh(); showResult('処理しています…');
    try {
      const result = await operation();
      showResult(result?.ok ? success : friendly(result?.reason), !result?.ok);
    } catch (_) { showResult('処理を完了できませんでした。設定画面を再読み込みしてください。', true); }
    finally { busy = false; await refresh(); }
  }
  $('pair-form').addEventListener('submit', event => {
    event.preventDefault();
    const code = $('pair-code').value.trim();
    $('pair-code').value = '';
    void action(() => send('pair', { code }), '接続しました。AI のタブを一度再読み込みしてから試してください。');
  });
  $('retry').addEventListener('click', () => void action(() => send('retry'), '接続状態を確認しました。'));
  $('pause').addEventListener('click', () => {
    const enabled = !snapshot?.enabled;
    void action(() => send('enabled', { enabled }), enabled ? '監視を再開しました。' : '監視を一時停止しました。');
  });
  $('unpair').addEventListener('click', () => {
    if (!confirm('この Chrome の接続鍵と未送信の通知を削除して、接続を解除しますか？')) return;
    void action(() => send('unpair'), 'この Chrome の接続を解除しました。デスクトップ側の登録は、MORI Desk で解除できます。');
  });
  void refresh();
  setInterval(() => { if (!busy) void refresh(); }, 2000);
})();
