# kaduiro.com 用の静的ページ候補

`dist/` は Cloudflare Pages に配置できる静的ページの原稿。現状は「配布版は準備中」と表示し、未署名のローカル候補へのリンクを置かない。Pages の接続や DNS 変更は未実施。

Pages の単一ファイル上限は25 MiB。署名済みの大きな成果物は、版ごとに GitHub Releases の不変 asset URL を使う。Windows／Mac の実機試験、署名・公証、Chrome Web Store、Google OAuth の公開判定が通った後に、`dist/index.html` の配布状況を更新し、SHA-256 とリリースノートを載せる。`dist/privacy.html` は運営主体・問い合わせ先・データ削除手順を公開前に確定して更新する。

Cloudflare では Pages プロジェクトにこの `dist/` を配置し、`kaduiro.com` を custom domain に設定する。独立サーバーは不要。Cloudflare のアカウントや課金設定をこのリポジトリに保存しない。
