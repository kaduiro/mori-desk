# MORI Browser Bridge — 実験用 Chrome 拡張機能

**現在の `0.1.7` は通常利用へ配布できない修正候補です。**
実サービスの会話の所属を確かめる処理が未実装のため、新しい観測を保留します。
設定画面に「会話の所属確認が未実装」と出た場合、再接続や F5 では解消しません。
初期化・再配置・登録・編集中カードの修正と独立試験は
[実行結果](../../../docs/recovery-execution-ja.md) を参照してください。以下は従来の機能と開発用の手順です。

MORI Desk と同じ PC で動く Chrome の ChatGPT / Claude 通常テキスト会話を、デスクトップ HUD に表示します。このディレクトリを Chrome に「パッケージ化されていない拡張機能を読み込む」で指定できます。ビルド、npm install、API キーは拡張機能側では不要です。

配布リポジトリを取得した直後の場所は **`overlay/extensions/browser-bridge`** です。デスクトップ用ソースを組み立てた後には **`.runtime/extensions/browser-bridge`** にも同じ拡張機能が配置されます。Chrome に読み込むのは、`manifest.json` が直接入っている方のディレクトリです。

## 起動

1. MORI Desk を起動し、ブラウザ接続画面から接続コードを発行します。
2. Chrome の `chrome://extensions` を開き、デベロッパーモードをオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」で **`overlay/extensions/browser-bridge`**、または組み立て後の **`.runtime/extensions/browser-bridge`** を選択します。
4. 拡張機能の設定画面にコードを貼り付け、「接続する」を押します。
5. 通常のテキスト会話で、生成中 → 回答を確認 → HUD の行から元のタブに戻る、を確認します。既に開いていたタブの監視も自動で復旧を試します。表示されない場合は、設定画面の **「タブの監視を確認・復旧」**を押してください。

最低機能要件は Chrome 120 です。実験には会社がサポートする最新の Chrome を使ってください。対応する会話 URL は `https://chatgpt.com/c/<id>`、`https://chatgpt.com/g/<g-で始まる識別子>/c/<id>`、`https://claude.ai/chat/<id>`、および新規会話のルート画面です。ChatGPT の `/g/<識別子>` は通常のテキスト入力欄を確認できる場合だけ扱います。プロジェクト管理・GPT 編集の画面、音声、画像・動画生成、Deep Research は対象外です。URL に対応したことは、利用対象の実サービス DOM の動作確認を意味しません。

## HUD に行が出ないとき

拡張機能の設定画面で **「タブの監視を確認・復旧」** を押すと、この Chrome プロファイルの ChatGPT / Claude タブを最大 20 件調べます。診断は接続前や監視停止中にも実行できます。本体との接続、ページ内の監視の応答、監視の復旧結果、対象外の URL、DOM を読み取れない画面、待機中、生成中を件数で表示します。URL・タイトル・会話本文・タブ ID は診断結果に保存しません。

0.1.6 は、初回接続、拡張の起動・更新、再接続、定期確認、診断で、応答しない監視プログラムの復旧を試します。監視が有効でペアリング済みの場合に、アクセスが許可された対応ページへ同梱の監視プログラムだけを再配置します。ページの再読み込みや自動でのタブの前面化は行わず、生成や未送信の文章には触れません。正常に応答する監視は重複して起動せず、失敗後は待機してから再確認します。

サイトへのアクセスがない場合は Chrome の拡張機能の詳細で ChatGPT / Claude への許可を確認してください。休止中のタブは自分で開き、読み込み中のページは表示が落ち着いてから診断します。復旧に失敗し続ける場合だけ、生成が終わるのを待ち、必要な未送信文を控えてからページを再読み込みしてください。監視を停止中・未ペアリングの場合は、勝手に監視を再開しません。

0.1.5 以降は、対応する会話は待機中でも HUD に行を作ります。過去の会話を開いたり再接続したりしただけで完了通知は作りません。ChatGPT のデスクトップアプリや別の Chrome プロファイルは、この拡張機能では監視できません。

## 会話を見分ける表示

0.1.5 は、現在の会話のタイトルと、最後に送信したユーザーの依頼の短い抜粋を HUD に届けます。タイトルは履歴・ナビゲーション内のリンクが現在の会話 ID と一致するときだけ読み取ります。抜粋は送信済みユーザーメッセージの目印を持つ最後の要素だけが対象です。タイトルと抜粋はそれぞれ最大 160 UTF-16 コード単位に制限し、改行や連続する空白を一行に整えます。外部の要約 API は使いません。

同じタブで別の会話へ移ったときは、前の会話の抜粋を新しい会話に流用しません。URL だけが切り替わり、古いメッセージの DOM が残っている間は、抜粋を取得できない状態として扱います。現在の会話に結びつくタイトルがない場合も空欄にし、汎用のページタイトルから推測しません。画面構造や履歴欄の有無により、タイトル・抜粋を取得できない場合があります。

同じ会話を二つのタブで開いたときは、それぞれ別の行・移動先として扱います。同じブラウザ起動内の接続復旧やページ再読み込みは既存のタブ記録を再利用します。Chrome 再起動や拡張機能の再読み込みで起動 ID が変わった場合、以前の記録は本体が履歴として扱います。本体と拡張機能を対応する版に更新してください。

0.1.3 は、従来の入力欄・停止ボタン・回答欄の目印がない ChatGPT 画面に、実験的な検知を追加します。一つの可視の編集可能な入力欄、一つの完全一致の短い停止ラベル（`Stop` / `停止` / `停止する`）、可視の `aria-busy="true"` が揃ったときだけ生成を開始します。短い停止ボタンだけ、処理中属性だけ、複数の入力欄・停止候補では生成を断定しません。

この組合せで開始した生成だけは、入力欄を引き続き確認でき、停止ボタンと処理中属性が両方消えた状態が800ミリ秒以上続くと `unverified` /「回答を確認」を通知します。従来形式で始まった生成の回答欄が見つからなくなった場合には、この条件を流用しません。画面全体の要素の有無を使う実験的な方式で、要素同士が同じフォームに属することや全アカウントの互換性を確認したものではありません。

## 接続エラーと拡張更新後のエラー

`ERR_CONNECTION_REFUSED` は、その接続試行時にローカルポートへの接続が受理されなかった記録です。WebSocket handshake の404は HTTP 応答者がいたものの、期待する `/browser/v1` 接続が成立しなかったことを示します。これだけで応答元の製品は特定できません。Chrome のエラー履歴と、設定画面に表示する現在の接続状態は分けて確認してください。

再接続は保存済みポートの後に23333〜23337を探索します。0.1.2 は自動再接続の待機を DOM 観測やアラームが迂回しないようにし、明示的な「本体に再接続」だけが待機を解除します。本体が停止している間の接続エラー自体を正常接続とは扱いません。

`Extension context invalidated` は、拡張を更新した後に古いページ側の監視処理が残る場合などに起きます。0.1.2 以降は同期例外と Promise の拒否を扱い、無効化された監視処理を停止します。0.1.6 では、新しい監視プログラムが応答しない対象タブへ、ページを再読み込みせず監視を復旧する処理を追加しました。設定画面の診断で復旧結果を確認できます。

具体的な本体起動・ポート確認の手順は [Windows の接続エラーの切り分け](../../../docs/windows-ja.md) を参照してください。

## 現在の検証範囲

この版の DOM アダプターは **実験用**です。合成 DOM フィクスチャとローカルプロトコルのテストは、実サービスの DOM 互換性や Windows / Mac の動作を証明しません。利用対象のアカウント、言語、Chrome バージョンで実際に検証し、画面構造が違う場合はアダプターを更新してください。

停止ボタンや streaming 属性は生成中の手掛かりです。停止ボタンが消えて入力欄と回答枠を再確認できた場合も、正常終了とは断定せず **`unverified` / 「回答を確認」**を通知します。この版はブラウザ由来の `completed` を生成しません。ユーザーが実際に停止ボタンをクリックした場合は中断、明示的なエラー属性を検出した場合はエラーとして扱います。

1 タブの会話が 1 行です。同じ会話を別タブでも開くと別々の行になります。最大 20 タブを監視し、未送信の終端・閉鎖メタデータは最大 200 件 / 512 KiB 保持します。上限や保存失敗は設定画面に表示します。

## データと接続

- 現在の会話タイトルと最後に送信したユーザーの依頼の抜粋だけを、各 160 UTF-16 コード単位までローカルの MORI Desk に送ります。入力途中・編集中の文章、AI の回答、Cookie、API キー、HTML は読み出して送信しません。診断結果にはタイトルや抜粋を含めません。
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
node --test test/browser-extension-core.test.js test/browser-extension-metadata.test.js test/browser-extension-fixtures.test.js test/browser-extension-alternate-layout.test.js test/browser-extension-transport.test.js test/browser-extension-worker.test.js
```

MORI Desk 側の仕様は [ブラウザ接続プロトコル](https://github.com/kaduiro/mori-desk/blob/main/docs/browser-protocol-v1.md) を参照してください。実サイト確認では、複数タブの生成、停止、エラー、画面切り替え、再読み込み、スリープ復帰、MORI Desk 再起動、Chrome 再起動、未読のまま次の生成、HUD クリック中の別会話への移動を確認してください。

## Chrome での最初の接続確認

0.1.6ではLinuxのChrome for Testing 155.0.8059.84へ実際の拡張機能を読み込み、合成の会話ページとMoriのローカルWebSocketを使って、拡張の更新・再読み込み後にページを開き直さず監視が復旧することを確認しました。ただし、その試験は復旧も起動する診断を繰り返し呼んでおり、自動処理だけで復旧した証拠にはなりません。未送信文と既存の未確認通知の保持は確認しています。実際のChatGPT / ClaudeのDOM、利用者のChrome設定、Windows / macOSのサイト許可や組織ポリシーを確認した結果ではありません。詳細は[検証状況](../../../docs/verification-ja.md#ページ内の監視の自動復旧拡張機能016)を参照してください。

Service Worker は同梱スクリプトだけを `importScripts` で読み込み、CSP の `connect-src` に明記した 5 つの localhost WebSocket 接続先だけを使います。Chrome 公式の WebSocket サンプルも WebSocket 専用の host permission を宣言していませんが、localhost / loopback の扱いは Chrome のバージョンや管理ポリシーでも確認が必要です。

実際の Chrome で `chrome://extensions` から読み込み、拡張機能の Service Worker エラーがないこと、接続コードで相互認証できること、タブを閉じて開き直しても再接続できることを確認してください。接続が拒否された場合は、MORI Desk の起動、接続コード、拡張機能 ID、CSP エラー、Chrome のローカル接続・サイトアクセス設定、会社の管理ポリシーを順に確認します。

## 公式仕様

- [Chrome extension WebSocket service worker](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome storage API / access level](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome scripting API / 文書を指定した再配置](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome permissions API / 現在の許可の確認](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Chrome 公式 WebSocket サンプルの manifest](https://github.com/GoogleChrome/chrome-extensions-samples/blob/main/functional-samples/tutorial.websockets/manifest.json)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)

SPDX-License-Identifier: AGPL-3.0-only
