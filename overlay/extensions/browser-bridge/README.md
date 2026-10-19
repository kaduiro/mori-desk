# MORI Browser Bridge — 実験用 Chrome 拡張機能

MORI Desk と同じ PC で動く Chrome の ChatGPT / Claude 通常テキスト会話を、デスクトップ HUD に表示します。このディレクトリを Chrome に「パッケージ化されていない拡張機能を読み込む」で指定できます。ビルド、npm install、API キーは拡張機能側では不要です。

配布リポジトリを取得した直後の場所は **`overlay/extensions/browser-bridge`** です。デスクトップ用ソースを組み立てた後には **`.runtime/extensions/browser-bridge`** にも同じ拡張機能が配置されます。Chrome に読み込むのは、`manifest.json` が直接入っている方のディレクトリです。

## 起動

1. MORI Desk を起動し、ブラウザ接続画面から接続コードを発行します。
2. Chrome の `chrome://extensions` を開き、デベロッパーモードをオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」で **`overlay/extensions/browser-bridge`**、または組み立て後の **`.runtime/extensions/browser-bridge`** を選択します。
4. 拡張機能の設定画面にコードを貼り付け、「接続する」を押します。
5. 既に開いていた ChatGPT / Claude のページを再読み込みします。通常のテキスト会話で、生成中 → 回答を確認 → HUD の行から元のタブに戻る、を確認します。

最低機能要件は Chrome 120 です。実験には会社がサポートする最新の Chrome を使ってください。対応する会話 URL は `https://chatgpt.com/c/<id>`、`https://chatgpt.com/g/<g-で始まる識別子>/c/<id>`、`https://claude.ai/chat/<id>`、および新規会話のルート画面です。ChatGPT の `/g/<識別子>` は通常のテキスト入力欄を確認できる場合だけ扱います。プロジェクト管理・GPT 編集の画面、音声、画像・動画生成、Deep Research は対象外です。URL に対応したことは、利用対象の実サービス DOM の動作確認を意味しません。

## HUD に行が出ないとき

拡張機能の設定画面で **「表示されない原因を確認」** を押すと、この Chrome プロファイルの ChatGPT / Claude タブを最大 20 件調べます。診断は接続前や監視停止中にも実行でき、接続の不足、ページ再読み込み・サイトアクセスの確認が必要なタブ、対象外の URL、DOM を読み取れない画面、待機中、生成中を件数で表示します。URL・タイトル・会話本文・タブ ID は診断結果に保存しません。

初回追加や `chrome://extensions` で拡張機能を再読み込みした後は、既に開いている AI のタブも再読み込みしてください。回答の生成中であれば、その終了を待ってから行ってください。接続済みでも、待機中の過去の会話を開いただけでは HUD の行を作りません。この接続後に質問を送り、生成中の状態を一度観測すると行が作られます。ChatGPT のデスクトップアプリや別の Chrome プロファイルは、この拡張機能では監視できません。

## 現在の検証範囲

この版の DOM アダプターは **実験用**です。合成 DOM フィクスチャとローカルプロトコルのテストは、実サービスの DOM 互換性や Windows / Mac の動作を証明しません。利用対象のアカウント、言語、Chrome バージョンで実際に検証し、画面構造が違う場合はアダプターを更新してください。

停止ボタンや streaming 属性は生成中の手掛かりです。停止ボタンが消えて入力欄と回答枠を再確認できた場合も、正常終了とは断定せず **`unverified` / 「回答を確認」**を通知します。この版はブラウザ由来の `completed` を生成しません。ユーザーが実際に停止ボタンをクリックした場合は中断、明示的なエラー属性を検出した場合はエラーとして扱います。

1 タブの会話が 1 行です。同じ会話を別タブでも開くと別々の行になります。最大 20 タブを監視し、未送信の終端・閉鎖メタデータは最大 200 件 / 512 KiB 保持します。上限や保存失敗は設定画面に表示します。

## データと接続

- 会話本文、入力、ページタイトル、Cookie、API キー、HTML は読み出して送信しません。
- 会話の URL はブラウザが渡す `sender.url` と実際のタブから検証し、必要な会話パスだけを送ります。ChatGPT のプロジェクト・GPT 内でも送信する参照は `/c/<id>` に正規化し、プロジェクト名・GPT 名を含み得る scope 部分、クエリ、fragment は保存・送信しません。
- 接続鍵は `chrome.storage.local` の trusted extension contexts に制限します。Content Script に鍵を渡しません。Chrome の同期保存も使いません。
- localhost の `ws://127.0.0.1:23333–23337/browser/v1` だけに接続します。永久鍵をネットワークに流さず、接続ごとに HMAC-SHA-256 の相互認証を行います。HMAC 認証は WebSocket 本文の暗号化ではありません。
- 生成状態の観測と接続の生存確認は分離します。20 秒の ping は、タブの DOM が読み取れた証拠にはなりません。
- HUD の要求に応じて対象タブ・ウィンドウを前面に出し、操作前後に会話と document epoch を確認します。入力や送信の機能はありません。
- 初回インストール時、更新時、タブ再読み込みだけでは完了通知を作りません。回線断・ブラウザ終了・ページ閉鎖も正常終了には変換しません。

`manifest.json` の公開鍵で、開発用 ID を `obooegdoanifidoffaodpobadpeiilcl` に固定しています。この公開鍵は配布用署名鍵ではなく、秘密鍵はリポジトリに含まれません。正式配布では組織が管理する署名・更新運用と、新しい拡張機能 ID のデスクトップ許可設定が必要です。このソース版には第三者ストアの更新 URL を設定していません。

## テスト

配布リポジトリのルートでは、ラッパーの `scripts/run.js` が組み立て後の対象テストを列挙するため、次を実行します。

```sh
npm test
```

組み立て済みのソース内で拡張機能のテストだけを実行する場合は、先に **`.runtime`** に移動します。配布リポジトリ直下の `test/` を直接実行するコマンドではありません。

```sh
cd .runtime
node --test test/browser-extension-core.test.js test/browser-extension-fixtures.test.js test/browser-extension-transport.test.js test/browser-extension-worker.test.js
```

MORI Desk 側の仕様は [ブラウザ接続プロトコル](https://github.com/kaduiro/mori-desk/blob/main/docs/browser-protocol-v1.md) を参照してください。実サイト確認では、複数タブの生成、停止、エラー、画面切り替え、再読み込み、スリープ復帰、MORI Desk 再起動、Chrome 再起動、未読のまま次の生成、HUD クリック中の別会話への移動を確認してください。

## Chrome での最初の接続確認

この環境では Chrome 本体を起動して拡張機能を読み込む確認は実施していません。Node 上の WebSocket テストは、Chrome の CSP・権限・会社の管理ポリシーを検証するものではありません。

Service Worker は同梱スクリプトだけを `importScripts` で読み込み、CSP の `connect-src` に明記した 5 つの localhost WebSocket 接続先だけを使います。Chrome 公式の WebSocket サンプルも WebSocket 専用の host permission を宣言していませんが、localhost / loopback の扱いは Chrome のバージョンや管理ポリシーでも確認が必要です。

実際の Chrome で `chrome://extensions` から読み込み、拡張機能の Service Worker エラーがないこと、接続コードで相互認証できること、タブを閉じて開き直しても再接続できることを確認してください。接続が拒否された場合は、MORI Desk の起動、接続コード、拡張機能 ID、CSP エラー、Chrome のローカル接続・サイトアクセス設定、会社の管理ポリシーを順に確認します。

## 公式仕様

- [Chrome extension WebSocket service worker](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome storage API / access level](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Chrome 公式 WebSocket サンプルの manifest](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/functional-samples/tutorial.websockets/manifest.json)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)

SPDX-License-Identifier: AGPL-3.0-only
