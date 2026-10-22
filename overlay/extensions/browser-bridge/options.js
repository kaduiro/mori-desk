/* SPDX-License-Identifier: AGPL-3.0-only */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let snapshot = null;
  let busy = false;
  const checkTabsLabel = 'タブの監視を確認・復旧';
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
    tab_query_failed: 'Chrome のタブ一覧を取得できませんでした。保存データと接続は保持し、自動的に再試行します。',
    tab_query_timeout: 'Chrome のタブ一覧の応答が遅れています。保存データと接続は保持し、自動的に再試行します。',
    alarm_failed: '定期確認を準備できませんでした。保存データは保持しています。Chrome の拡張機能画面でエラーを確認してください。',
    recovery_failed: 'ページ内の監視の復旧を完了できませんでした。保存データは保持し、次の機会に再試行します。',
    initialization_failed: '拡張機能の初期化を完了できませんでした。保存障害かどうかは確認できていません。拡張機能のエラーを確認してください。',
    binding_unconfirmed: '画面の内容が現在の会話に属することを確認できないため、観測を保留しています。この試験版では会話の所属確認が未実装です。再接続や F5 では解消しません。',
    lease_invalid: '現在のページの観測許可を確認し直しています。既存の通知を保持して、自動的に再登録します。',
    lease_expired: 'ページの観測許可を更新しています。既存の通知を保持して、自動的に再登録します。',
    attempt_expired: '以前の復旧処理は期限切れになりました。現在の状態を確認して再試行します。',
    observer_version: 'ページ内の監視と拡張機能のバージョンが一致しません。現在の監視プログラムへの更新を試みます。',
    registration_failed: 'ページ内の監視の登録を確認できませんでした。自動的に再試行します。',
    local_data_invalid: '保存データを読み取れないため監視を停止しました。データを上書きせず、管理者に確認してください。',
    rate_limit: '状態の送信が一時的に制限されました。通知を保持して再接続します。',
    resync_required: '表示を同期し直しています。',
    receipt_limit: 'MORI Desk の通知保存数が上限に達しました。デスクトップ側で通知を整理してください。',
    session_limit: 'MORI Desk のセッション数が上限に達しました。デスクトップ側で不要な行を整理してください。',
    unpaired: 'MORI Desk で接続コードを発行して、この画面で登録してください。',
    paused: '観測を受け付けていません。接続状況を確認し、「監視を再開」を押してください。',
    old_document: `観測元と現在のタブの一致を確認できませんでした。ページの読み込みを待って、「${checkTabsLabel}」を押してください。`,
    invalid_sender: `Chrome から届いた観測元を確認できませんでした。「${checkTabsLabel}」でページ内の監視を確認してください。`,
    old_observation: '観測の到着が遅れたため、現在の状態として受け付けませんでした。PC のスリープやページの読み込みが落ち着いてから、もう一度確認してください。',
    duplicate_observation: `新しい観測の順序を確認できませんでした。少し待ってから「${checkTabsLabel}」を押してください。`,
    invalid_observation: `観測データの形式を確認できませんでした。拡張機能が最新か確認し、「${checkTabsLabel}」を押してください。`,
    tab_unavailable: '現在のタブからの応答を確認できませんでした。AI タブを前面に出して、もう一度確認してください。',
    observation_failed: '生成状態を拡張機能が受け付けられませんでした。接続状況を確認して、もう一度確認してください。',
    worker_unavailable: `ページから拡張機能への応答を確認できませんでした。「${checkTabsLabel}」を押し、続く場合は Chrome の拡張機能画面でエラーを確認してください。`,
    ack_unavailable: `ページ内の監視から、観測の受付結果が返りませんでした。「${checkTabsLabel}」で監視の状態と復旧結果を確認してください。`,
  };
  const recoveryReasons = {
    paused: '監視を一時停止しているため、復旧も待っています。「監視を再開」を押してください。',
    unpaired: 'MORI Desk の接続コードで登録してから、タブの監視を確認してください。',
    storage_failed: '保存先の問題があるため復旧を止めています。空き容量と拡張機能のエラーを確認してください。',
    binding_unconfirmed: errors.binding_unconfirmed,
    lease_invalid: errors.lease_invalid,
    attempt_expired: errors.attempt_expired,
    observer_version: errors.observer_version,
    registration_failed: errors.registration_failed,
    tab_query_failed: errors.tab_query_failed,
    tab_query_timeout: errors.tab_query_timeout,
    initialization_failed: errors.initialization_failed,
    tab_loading: 'ページの読み込み中です。読み込みが終わってから、もう一度確認してください。',
    tab_discarded: 'Chrome が休止させたタブです。AI タブを開いて再開し、もう一度確認してください。',
    tab_frozen: 'Chrome が動作を止めているタブです。AI タブを開いてから、もう一度確認してください。',
    unsupported_route: '対象外のページです。ChatGPT / Claude の通常の会話画面を開いてください。',
    recovery_cooldown: '直前の復旧処理から少し待っています。しばらくしてから、もう一度確認してください。',
    recovery_limit: '一度に確認するタブ数の上限に達したため、今回の復旧を待っています。少し待ってから、もう一度確認してください。',
    probe_timeout: 'ページ内の監視の応答を待っています。監視が重複しないよう復旧を保留しています。AI タブを開いて少し待ち、もう一度確認してください。',
    navigation_changed: '会話やページの切り替え中です。切り替えが終わってから、もう一度確認してください。',
    permission_required: '既存タブの監視を復旧するためのアクセスが許可されていません。Chrome の拡張機能画面で、この拡張機能が有効か、ChatGPT / Claude のサイトへのアクセスが許可されているか確認してください。組織が管理している場合は管理者の設定を確認してください。',
    scripting_unavailable: 'この Chrome では既存タブの監視を復旧する準備ができていません。拡張機能が最新で、有効になっているか確認してください。',
    injection_failed: 'ページ内の監視を復旧できませんでした。AI タブを開き、サイトへのアクセスが許可されているか確認してから、もう一度試してください。',
    recovery_timeout: '復旧後の監視の応答を確認できませんでした。AI タブを開いて少し待ち、もう一度確認してください。',
    observer_unavailable: '復旧後もページ内の監視から応答がありません。拡張機能のエラーを確認し、もう一度試してください。',
  };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

  function friendly(code) { return Object.hasOwn(errors, code) ? errors[code] : '処理を完了できませんでした。MORI Desk と拡張機能のバージョンを確認してください。'; }
  async function send(type, extra = {}) { return chrome.runtime.sendMessage({ type: `mori.options.${type}`, ...extra }); }
  function showResult(text, error = false) {
    $('action-result').textContent = text;
    $('action-result').dataset.error = String(error);
  }
  function showObserverRecovery(result, line) {
    const recovery = result.observerRecovery;
    if (!recovery) {
      if (result.counts.needsReload) line(`自動復旧の結果は届いていません。拡張機能が最新か確認してから、「${checkTabsLabel}」を押してください。`);
      return;
    }
    const attempted = count(recovery.attempted), recovered = count(recovery.recovered);
    const deferred = count(recovery.deferred), failed = count(recovery.failed);
    if (attempted || recovered || deferred || failed) {
      line(`ページ内の監視：復旧 ${recovered} 件・待機 ${deferred} 件・復旧できず ${failed} 件（自動復旧を試したタブ ${attempted} 件）。`);
    } else if (result.counts.needsReload) {
      line('ページ内の監視：今回は自動復旧を行っていません。拡張機能の更新とサイトへのアクセスを確認してから、もう一度確認してください。');
    } else if (result.checkedTabs) {
      line('ページ内の監視：今回、復旧が必要なタブは見つかりませんでした。');
    }
    for (const [reason, value] of Object.entries(recovery.reasons || {})) {
      const total = count(value);
      if (!total) continue;
      const explanation = Object.hasOwn(recoveryReasons, reason) ? recoveryReasons[reason]
        : '復旧結果を確認できませんでした。拡張機能の状態を確認してから、もう一度試してください。';
      line(`${total} 件：${explanation}`);
    }
    if (recovered) line('復旧したタブの観測の受付結果を、下に表示します。MORI Desk への反映は、本体の「ブラウザ連携・セッション」でも確認できます。');
    if (['injection_failed', 'recovery_timeout', 'observer_unavailable'].some(reason => count(recovery.reasons?.[reason]))) {
      line('復旧を試しても直らない場合の最後の手段として、AI タブを再読み込み（F5）できます。回答の生成が終わるのを待ち、未送信の文章を別の場所に控えてから行ってください。');
    }
  }
  function showTabHealth(result) {
    const container = $('tab-health');
    container.hidden = false; container.replaceChildren();
    const line = text => { const paragraph = document.createElement('p'); paragraph.textContent = text; container.append(paragraph); };
    if (!result?.ok || !result.counts) { line(friendly(result?.reason)); return; }
    if (!result.paired) line('本体との接続は未登録です。この画面の接続コード欄で MORI Desk と接続してください。');
    else if (!result.enabled) line('監視を停止しています。「監視を再開」を押してください。');
    else if (result.connectionState !== 'connected') line('本体との通信はまだ接続できていません。MORI Desk を起動し、「本体に再接続」を押してください。');
    else line('本体との通信は接続済みです。ページ内の監視の結果は以下で確認できます。');
    const counts = result.counts;
    line(`対象タブ ${result.totalTabs} 件中 ${result.checkedTabs} 件を確認しました。生成中 ${counts.running} 件・生成停止を観測 ${counts.settled} 件・待機中 ${counts.idle} 件。`);
    if (!result.totalTabs) line('確認できる対象タブがありません。この Chrome プロファイルで chatgpt.com または claude.ai を開き、拡張機能のサイトへのアクセスも確認してください。デスクトップ版 AI アプリや、別の Chrome プロファイルは対象になりません。');
    if (result.siteAccess) {
      const access = result.siteAccess;
      line(`2 サイトへの常時アクセス：許可を確認 ${count(access.granted)} 件・設定の確認が必要 ${count(access.missing)} 件・取得できず ${count(access.unknown)} 件。`);
      if (count(access.missing) || count(access.unknown)) line('Chrome の拡張機能画面で、ChatGPT / Claude のサイトへのアクセスを確認してください。この件数は常時アクセスの設定状況で、開いているタブの数ではありません。');
    }
    if (counts.needsReload) line(`${counts.needsReload} 件でページ内の監視の応答を確認できていません。以下の復旧結果を確認してください。`);
    showObserverRecovery(result, line);
    if (counts.unsupportedRoute) line(`${counts.unsupportedRoute} 件は対象外のページです。ChatGPT / Claude の会話画面を開いてください。プロジェクトの管理画面や GPT の編集画面は監視しません。`);
    if (counts.unknown) line(`${counts.unknown} 件で現在の生成状態を読み取れません。ページの読み込みを待ち、通常のテキスト会話で確認してください。画面変更に追従できない場合も、回答完了とは判定しません。`);
    if (counts.idle) line('待機中のタブも監視プログラムが動いています。接続先が観測を受け付けると、現在開いている会話が HUD に表示されます。開いただけで完了通知は出しません。');
    if (counts.settled) line('生成停止を観測したタブでは、回答やエラーの有無を確認してください。停止したことだけでは正常終了とは断定しません。');
    const delivery = result.observationDelivery;
    if (delivery) {
      line(`拡張機能が観測を受け付けたタブ ${delivery.accepted} 件・受け付けられなかったタブ ${delivery.rejected} 件・受付結果が未確認のタブ ${delivery.unconfirmed} 件。`);
      if (counts.needsReload && !delivery.accepted && !delivery.rejected && !delivery.unconfirmed) line('ページ内の監視から応答がないため、観測の受付結果もまだ届いていません。');
      for (const [reason, value] of Object.entries(delivery.reasons || {})) if (count(value)) line(`${count(value)} 件：${friendly(reason)}`);
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
        ? `MORI Desk との通信は接続済みです。ページ内の監視は「${checkTabsLabel}」で確認できます。`
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
      // Health remains read-only when storage failure blocks recovery/actions.
      $('check-tabs').disabled = busy;
      $('diagnostic').hidden = !snapshot.diagnostic;
      $('diagnostic').textContent = snapshot.diagnostic ? friendly(snapshot.diagnostic) : '';
      $('version').textContent = `MORI Browser Bridge ${snapshot.version} · ローカル接続`;
      $('extension-id').textContent = snapshot.extensionId;
    } catch (_) {
      $('connection').textContent = '拡張機能を確認してください';
      $('connection-detail').textContent = '設定画面を再読み込みするか、Chrome の拡張機能管理画面でエラーを確認してください。';
    }
  }
  async function action(operation, success, progress = '処理しています…') {
    if (busy) return;
    busy = true; await refresh(); showResult(progress);
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
    void action(() => send('pair', { code }), `接続しました。ページ内の監視は「${checkTabsLabel}」で確認できます。`);
  });
  $('retry').addEventListener('click', () => void action(() => send('retry'), '本体との接続状態を確認しました。'));
  $('check-tabs').addEventListener('click', () => void action(async () => {
    const result = await send('health'); showTabHealth(result); return result;
  }, '確認が終わりました。タブの監視の結果は上に表示しています。', 'タブの監視を確認し、必要な復旧を試しています…'));
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
