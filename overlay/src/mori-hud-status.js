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
    if (!snapshot || !Array.isArray(snapshot.sessions)) return null;
    const status = snapshot.moriBrowserStatus;
    if (!status || status.dnd === true || typeof status.state !== "string"
        || !Object.prototype.hasOwnProperty.call(notices, status.state)) return null;
    if (status.state === "ready" && Array.isArray(status.providers)) {
      // Use only the current, sanitized provider summary from the desktop.
      // A socket alone is not evidence that either page is being observed.
      const names = { chatgpt: "ChatGPT", claude: "Claude" };
      const providers = status.providers.filter(row => row && Object.hasOwn(names, row.provider));
      const detailed = providers.filter(row => Number.isSafeInteger(row.fresh));
      if (detailed.length === providers.length && detailed.length) return {
        label: detailed.map(row => `${names[row.provider]} 監視中${row.fresh}件`).join('・'),
        detail: detailed.map(row => `${names[row.provider]}：${row.detail || row.label}`).join('。'),
      };
      if (providers.some(row => row.state === 'unknown')) return {
        label: 'タブの確認状況は不明',
        detail: '対象タブの取得またはサイトへのアクセスを確認できていません。クリックしてサービス別の確認状況を開いてください。',
      };
      if (snapshot.sessions.length) return null;
      const blocked = providers.filter(row => row.state === "unconfirmed");
      if (blocked.length) return {
        label: `${[...new Set(blocked.map(row => names[row.provider]))].join("・")}：監視を保留`,
        detail: "会話の所属を確認できないため、生成状態を観測していません。再接続だけでは解消しません。クリックしてサービス別の確認状況を開いてください。",
      };
      if (providers.some(row => row.state === "unknown")) return {
        label: "タブの確認状況は不明",
        detail: "Chrome との通信は接続済みですが、対象タブの取得またはサイトへのアクセスを確認できていません。クリックしてサービス別の確認状況を開いてください。",
      };
    }
    return snapshot.sessions.length ? null : notices[status.state];
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
