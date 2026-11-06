# kaduiro.com 用の静的ページ候補

`dist/` は Cloudflare Pages に配置できる静的ページの原稿。現状は「配布版は準備中」と表示し、インストール受入試験が終わっていないローカル候補へのリンクを置かない。Pages の接続や DNS 変更は未実施。

Pages の単一ファイル上限は25 MiB。大きな成果物は、版ごとに GitHub Releases の不変 asset URL を使う。個人作品の限定試験では署名・公証・Chrome Web Store 登録を必須としない。インストール試験を終えて配布範囲を決めたら、`dist/index.html` の配布状況を更新し、配布ファイルの SHA-256、署名・公証の有無、Chrome 拡張の導入方法とリリースノートを載せる。`dist/privacy.html` は運営主体・問い合わせ先・データ削除手順を公開前に確定して更新する。Google OAuth の審査条件は利用者の範囲に合わせて判断する。

Cloudflare では Pages プロジェクトにこの `dist/` を配置し、`kaduiro.com` を custom domain に設定する。独立サーバーは不要。Cloudflare のアカウントや課金設定をこのリポジトリに保存しない。
