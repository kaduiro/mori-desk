"use strict";

(function exposeMoriHudStatus(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MoriHudStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildMoriHudStatus() {
  // These notices describe only the local browser connection. They never
  // represent a session, an active generation, or a completion receipt.
  const notices = Object.freeze({
    starting: Object.freeze({
      label: "ブラウザ連携を準備中",
      detail: "Mori Desk の接続準備中です。クリックするとブラウザ連携画面を開きます。",
    }),
    pairing: Object.freeze({
      label: "Chrome と接続",
      detail: "ブラウザ連携画面で拡張機能を読み込み、接続コードでペアリングしてください。",
    }),
    disconnected: Object.freeze({
      label: "ブラウザ接続待ち",
      detail: "登録済みの Chrome 拡張機能との接続を待っています。クリックして接続状態を確認してください。",
    }),
    ready: Object.freeze({
      label: "生成状態は未受信",
      detail: "Chrome との接続はありますが、AI ページの状態はまだ届いていません。クリックして確認手順を開いてください。",
    }),
    unavailable: Object.freeze({
      label: "接続状態を確認",
      detail: "ブラウザ連携の準備ができませんでした。クリックして接続画面の説明を確認してください。",
    }),
  });

  function getMoriHudStatus(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.sessions) || snapshot.sessions.length !== 0) return null;
    const status = snapshot.moriBrowserStatus;
    if (!status || status.dnd === true || typeof status.state !== "string"
        || !Object.prototype.hasOwnProperty.call(notices, status.state)) return null;
    return notices[status.state];
  }

  return { getMoriHudStatus };
});
