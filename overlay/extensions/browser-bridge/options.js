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
    paused: '観測を受け付けていません。接続状況を確認し、「監視を再開」を押してください。',
    old_document: '観測元と現在のタブの一致を確認できませんでした。ページの読み込みを待って、もう一度確認してください。続く場合は、回答生成の終了後に AI タブを F5 で再読み込みしてください。',
    invalid_sender: 'Chrome から届いた観測元を確認できませんでした。拡張機能を更新した場合は、回答生成の終了後に AI タブも F5 で再読み込みしてください。',
    old_observation: '観測の到着が遅れたため、現在の状態として受け付けませんでした。PC のスリープやページの読み込みが落ち着いてから、もう一度確認してください。',
    duplicate_observation: '新しい観測の順序を確認できませんでした。もう一度確認し、続く場合は回答生成の終了後に AI タブを再読み込みしてください。',
    invalid_observation: '観測データの形式を確認できませんでした。拡張機能を更新した場合は、回答生成の終了後に AI タブも再読み込みしてください。',
    tab_unavailable: '現在のタブからの応答を確認できませんでした。AI タブを前面に出して、もう一度確認してください。',
    observation_failed: '生成状態を拡張機能が受け付けられませんでした。接続状況を確認して、もう一度確認してください。',
    worker_unavailable: 'ページから拡張機能への応答を確認できませんでした。もう一度確認し、続く場合は拡張機能と AI タブを再読み込みしてください。',
    ack_unavailable: 'ページの監視プログラムから、観測の受付結果が返りませんでした。古い版が残っている場合があるため、回答生成の終了後に AI タブを F5 で再読み込みしてください。',
  };

  function friendly(code) { return errors[code] || '処理を完了できませんでした。MORI Desk と拡張機能のバージョンを確認してください。'; }
  async function send(type, extra = {}) { return chrome.runtime.sendMessage({ type: `mori.options.${type}`, ...extra }); }
  function showResult(text, error = false) {
    $('action-result').textContent = text;
    $('action-result').dataset.error = String(error);
  }
  function showTabHealth(result) {
    const container = $('tab-health');
    container.hidden = false; container.replaceChildren();
    const line = text => { const paragraph = document.createElement('p'); paragraph.textContent = text; container.append(paragraph); };
    if (!result?.ok || !result.counts) { line(friendly(result?.reason)); return; }
    if (!result.paired) line('先に、この画面の接続コード欄で MORI Desk と接続してください。');
    else if (!result.enabled) line('監視を停止しています。「監視を再開」を押してください。');
    else if (result.connectionState !== 'connected') line('MORI Desk との接続がまだ完了していません。アプリを起動し、「今すぐ再接続」を押してください。');
    const counts = result.counts;
    line(`対象タブ ${result.totalTabs} 件中 ${result.checkedTabs} 件を確認しました。生成中 ${counts.running} 件・生成停止を観測 ${counts.settled} 件・待機中 ${counts.idle} 件。`);
    if (!result.totalTabs) line('この Chrome プロファイルで chatgpt.com または claude.ai を開き、拡張機能のサイトへのアクセスが許可されているか確認してください。デスクトップ版 AI アプリや、別の Chrome プロファイルは対象になりません。');
    if (counts.needsReload) line(`${counts.needsReload} 件でページの監視プログラムから応答がありません。開いている AI タブを F5 で再読み込みし、拡張機能のサイトへのアクセスを確認してください。回答生成中なら、終了してから再読み込みしてください。`);
    if (counts.unsupportedRoute) line(`${counts.unsupportedRoute} 件は対象外のページです。ChatGPT / Claude の会話画面を開いてください。プロジェクトの管理画面や GPT の編集画面は監視しません。`);
    if (counts.unknown) line(`${counts.unknown} 件で現在の生成状態を読み取れません。ページの読み込みを待ち、通常のテキスト会話で確認してください。画面変更に追従できない場合も、回答完了とは判定しません。`);
    if (counts.idle) line('待機中のタブは監視プログラムが動いています。HUD に初めて行を出すには、この接続後に質問を送信し、生成中の状態を観測する必要があります。');
    if (counts.settled) line('生成停止を観測したタブでは、回答やエラーの有無を確認してください。停止したことだけでは正常終了とは断定しません。');
    const delivery = result.observationDelivery;
    if (delivery) {
      line(`拡張機能が観測を受け付けたタブ ${delivery.accepted} 件・受け付けられなかったタブ ${delivery.rejected} 件・受付結果が未確認のタブ ${delivery.unconfirmed} 件。`);
      for (const [reason, count] of Object.entries(delivery.reasons || {})) line(`${count} 件：${friendly(reason)}`);
    }
    if (counts.running && result.paired && result.enabled && result.connectionState === 'connected') {
      if (delivery?.runningAccepted) line(`生成中 ${delivery.runningAccepted} 件の観測を拡張機能が受け付けました。MORI Desk への反映は、アプリの「ブラウザ連携・セッション」で確認できます。`);
      else line('ページでは生成中ですが、その観測を拡張機能が受け付けたことは確認できていません。上の受付結果を確認してください。');
    }
    if (result.remainingTabs) line(`負荷を抑えるため、残り ${result.remainingTabs} 件は今回確認していません。不要な AI タブを閉じて、もう一度確認してください。`);
    line('この診断は件数だけを表示し、ページの URL・タイトル・会話本文を保存しません。');
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
      $('check-tabs').disabled = busy || !snapshot.ok;
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
  $('check-tabs').addEventListener('click', () => void action(async () => {
    const result = await send('health'); showTabHealth(result); return result;
  }, '表示されない原因の確認が終わりました。上の診断結果を確認してください。'));
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
