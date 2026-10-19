"use strict";

// Desktop connection state is separate from provider observations. A paired
// socket cannot prove that a content script is installed in a particular tab.
function getBrowserStatus({ bridge = null, port = null, error = "" } = {}) {
  const connectedCount = Array.isArray(bridge?.connectedClients) ? bridge.connectedClients.length : 0;
  const pairedCount = Array.isArray(bridge?.pairedClients) ? bridge.pairedClients.length : 0;
  const listening = Number.isInteger(port) && port > 0 && port <= 65535;
  const canPair = listening && bridge?.available === true && bridge.pairingAvailable === true && !error;
  let state;
  if (error || (bridge && (bridge.available === false || bridge.pairingAvailable === false))) state = "unavailable";
  else if (!bridge || !listening) state = "starting";
  else if (connectedCount) state = "ready";
  else if (pairedCount) state = "disconnected";
  else state = "pairing";

  const labels = {
    starting: "接続準備中",
    pairing: "Chrome 未登録",
    disconnected: "Chrome 未接続",
    ready: `${connectedCount} ブラウザ接続中`,
    unavailable: "接続状態を確認",
  };
  const details = {
    starting: "Mori Desk の接続サーバーを準備しています。",
    pairing: "AI を使っている Chrome プロファイルに拡張機能を読み込み、下の接続コードで登録してください。",
    disconnected: "登録した Chrome と通信できていません。Chrome の MORI Browser Bridge を開き、監視の再開・再接続を確認してください。",
    ready: "Chrome と接続しています。対象の AI タブを拡張機能が読み取れているかは、Chrome 側の「表示されない原因を確認」で確認できます。",
    unavailable: "ブラウザ連携を開始できません。下の接続エラーを確認してください。",
  };
  const emptyText = state === "ready"
    ? "生成状態はまだ届いていません。Chrome の MORI Browser Bridge で「表示されない原因を確認」を押してください。更新直後は、拡張機能と AI のタブの両方を再読み込みします。"
    : state === "pairing"
      ? "Chrome の登録が完了すると、観測できた生成中の会話がここに表示されます。"
      : state === "disconnected"
        ? "Chrome の再接続を待っています。AI を使っているプロファイルの拡張機能を確認してください。"
        : state === "unavailable"
          ? "接続の問題を解消してから、Chrome とペアリングしてください。"
          : "接続サーバーの準備が終わるまでお待ちください。";
  return { state, label: labels[state], detail: details[state], emptyText,
    connectedCount, pairedCount, canPair, port: listening ? port : null };
}

module.exports = { getBrowserStatus };
