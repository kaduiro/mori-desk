"use strict";

const PROVIDERS = ["chatgpt", "claude"];
const NAMES = { chatgpt: "ChatGPT", claude: "Claude" };

function healthFor(bridge, client) {
  return bridge?.clientHealth?.find(item => item.clientId === client.clientId
    && item.browserRunId === client.browserRunId && item.state === "current")?.health || null;
}

function providerStatuses(bridge, clients) {
  return PROVIDERS.map(provider => {
    const reports = clients.map(client => healthFor(bridge, client)?.providers?.find(row => row.provider === provider));
    const known = reports.filter(row => row?.inventory === "known");
    const unknown = reports.length - known.length;
    const discovered = known.reduce((sum, row) => sum + row.discovered, 0);
    const admitted = known.reduce((sum, row) => sum + row.admitted, 0);
    const unconfirmed = known.reduce((sum, row) => sum + row.reasons.unconfirmed, 0);
    const unavailable = known.reduce((sum, row) => sum + row.reasons.unavailable, 0);
    const overLimit = known.reduce((sum, row) => sum + row.reasons.over_limit, 0);
    let state = "checking";
    let label = "新しい観測は未確認";
    let detail = `対象 ${discovered} 件・ページの登録 ${admitted} 件。会話ごとの生成状態は下の一覧で確認します。`;
    if (!clients.length) {
      state = "waiting"; label = "ブラウザの接続待ち";
      detail = "対象の Chrome プロファイルとページが利用可能になると、確認を進めます。";
    } else if (unknown) {
      state = "unknown"; label = known.length ? "一部の確認が未完了" : "確認状況は不明";
      detail = `${unknown} ブラウザで、対象タブの取得またはサイトへのアクセスを確認できていません。${known.length ? `確認済みの範囲では対象 ${discovered} 件です。` : "対象が 0 件と確認できた状態ではありません。"}`;
    } else if (!discovered) {
      state = "no_tabs"; label = "対象タブなし";
      detail = "接続中のブラウザで対象の会話タブを開くと、確認を進めます。";
    } else if (unconfirmed) {
      state = "unconfirmed"; label = "会話の識別が未確認";
      detail = `対象 ${discovered} 件のうち ${unconfirmed} 件で、表示中の会話と観測内容の対応を確認できていません。再接続だけでは監視の成立を確認できません。`;
    } else if (unavailable) {
      state = "unavailable"; label = "ページの応答を確認中";
      detail = `対象 ${discovered} 件のうち ${unavailable} 件でページの応答を確認できません。自動で再確認し、続く場合は拡張機能のサイトへのアクセスを確認してください。`;
    }
    if (overLimit) detail += ` ${overLimit} 件は監視タブ数の上限を超えています。`;
    // Aggregate health never promotes a row or claims end-to-end recovery.
    return { provider, name: NAMES[provider], state, label, detail,
      discovered: !clients.length || unknown ? null : discovered, admitted: !clients.length || unknown ? null : admitted };
  });
}

function deliveryStatus(bridge, clients) {
  const values = clients.map(client => healthFor(bridge, client)?.delivery);
  if (values.some(value => value?.state === "capacity_blocked")) {
    return { state: "capacity_blocked", label: "通知の保存容量が不足しています。保存済みの通知は保持しています。" };
  }
  if (!values.length || values.some(value => !value || value.state === "unknown")) {
    return { state: "unknown", label: "保存済み通知の同期状況は未確認" };
  }
  const remaining = values.reduce((sum, value) => sum + value.remainingReplay, 0);
  const livePending = values.reduce((sum, value) => sum + value.livePending, 0);
  return remaining ? { state: "syncing", label: `保存済み通知を同期中：残り ${remaining} 件` }
    : livePending ? { state: "syncing", label: `新しく受け付けた通知を送信中：残り ${livePending} 件` }
      : { state: "current", label: "保留中の通知はありません" };
}

function loginStatus(value) {
  const labels = { enabled: "ログイン時の自動起動：有効", disabled: "ログイン時の自動起動：無効",
    os_disabled: "ログイン時の自動起動：OS 側で無効", legacy: "ログイン時の自動起動：以前の登録を確認",
    unconfirmed: "ログイン時の自動起動：登録状態は未確認", unavailable: "ログイン時の自動起動：この環境では未確認" };
  const state = Object.hasOwn(labels, value?.state || "") ? value.state : "unconfirmed";
  return { state, label: labels[state] };
}

// A paired socket cannot prove that a page is observing a particular session.
function getBrowserStatus({ bridge = null, port = null, error = "", listener = null, login = null, buildInfo = null } = {}) {
  const clients = Array.isArray(bridge?.connectedClients) ? bridge.connectedClients : [];
  const connectedCount = clients.length;
  const pairedCount = Array.isArray(bridge?.pairedClients) ? bridge.pairedClients.length : 0;
  const actualPort = listener ? (listener.state === "listening" ? listener.port : null) : port;
  const listening = Number.isInteger(actualPort) && actualPort > 0 && actualPort <= 65535;
  const canPair = listening && bridge?.available === true && bridge.pairingAvailable === true && !error;
  let state;
  if (error || listener?.state === "blocked" || (bridge && (bridge.available === false || bridge.pairingAvailable === false))) state = "unavailable";
  else if (listener?.state === "disposed") state = "stopped";
  else if (listener?.state === "retry_wait") state = "retrying";
  else if (!bridge || !listening) state = "starting";
  else if (connectedCount) state = "ready";
  else if (pairedCount) state = "disconnected";
  else state = "pairing";

  const labels = {
    starting: "接続準備中",
    retrying: "接続先を再準備中",
    stopped: "ブラウザ連携は停止中",
    pairing: "Chrome 未登録",
    disconnected: "Chrome 未接続",
    ready: `${connectedCount} ブラウザ通信接続中`,
    unavailable: "接続状態を確認",
  };
  const details = {
    starting: "Mori Desk の接続サーバーを準備しています。",
    retrying: "この PC の接続先を確保できません。自動で再試行しています。保存済みの登録と通知は保持しています。",
    stopped: "ブラウザ連携は終了しています。次の起動は自動起動の設定に従います。",
    pairing: "AI を使っている Chrome プロファイルに拡張機能を読み込み、下の接続コードで登録してください。",
    disconnected: "登録した Chrome との再接続を待っています。対象プロファイルが起動し、監視が有効なら自動で再接続します。停止している場合は拡張機能から再開してください。",
    ready: "Chrome との通信は接続済みです。ChatGPT と Claude の確認状況は下に表示します。通信の接続と、会話を監視できることを分けて確認します。",
    unavailable: "ブラウザ連携を開始できません。接続エラーと自動起動の状態を確認してください。",
  };
  const emptyText = state === "ready"
    ? "生成状態はまだ届いていません。下のサービス別の確認状況を確認してください。"
    : state === "pairing"
      ? "Chrome の登録が完了すると、観測できた会話が待機中でもここに表示されます。"
      : state === "disconnected"
        ? "Chrome の再接続を待っています。以前の記録と未確認通知は保持しています。"
        : state === "unavailable"
          ? "接続の問題を確認してください。ペアリングの作り直しだけでは解決しない場合があります。"
          : "接続サーバーの準備が終わるまでお待ちください。";
  const build = buildInfo || bridge?.build;
  return { state, label: labels[state], detail: details[state], emptyText,
    connectedCount, pairedCount, canPair, port: listening ? actualPort : null,
    providers: providerStatuses(bridge, clients), delivery: deliveryStatus(bridge, clients), login: loginStatus(login),
    desktopVersion: build?.desktopVersion || null,
    versions: clients.map((client, index) => {
      const health = healthFor(bridge, client);
      return { label: `ブラウザ ${index + 1}`, extensionVersion: health?.extensionVersion || null,
        observerVersion: health?.observerVersion || null,
        compatibility: health ? "詳細状態の受信に対応" : "拡張の読込版・詳細状態は未確認" };
    }) };
}

module.exports = { getBrowserStatus, providerStatuses, deliveryStatus };
