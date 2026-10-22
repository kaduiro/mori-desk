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
    retrying: Object.freeze({
      label: "ブラウザ接続先を再準備中",
      detail: "この PC の接続先を自動で再試行しています。保存済みの通知は保持しています。",
    }),
    stopped: Object.freeze({
      label: "ブラウザ連携は停止中",
      detail: "Mori Desk のブラウザ連携は終了しています。",
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

  function isBrowserHistory(row) {
    return row?.source === "browser" && (row.isHistory === true || row.isCurrent === false);
  }

  function getMoriHudHistory(snapshot) {
    if (!snapshot || snapshot.moriBrowserStatus?.dnd === true) return null;
    const history = snapshot.moriBrowserHistory;
    if (!history || !Number.isSafeInteger(history.count) || history.count <= 0) return null;
    const unreadCount = Number.isSafeInteger(history.unreadCount) ? Math.max(0, history.unreadCount) : 0;
    return {
      label: `以前の記録 ${history.count} 件${unreadCount ? ` · 未確認 ${unreadCount} 件` : ""}`,
      detail: "閉じたタブや以前の接続の記録です。クリックすると未確認通知と詳細を確認できます。",
      sessionId: typeof history.firstSessionId === "string" ? history.firstSessionId : null,
      unreadCount,
    };
  }

  // Matches the browser-only row CSS. CLI rows keep their inherited geometry.
  function getMoriBrowserRowHeight(row) {
    return row?.source === "browser" ? (row.requestPreview ? 66 : 48) : 28;
  }

  return { getMoriHudStatus, getMoriHudHistory, isBrowserHistory, getMoriBrowserRowHeight };
});
