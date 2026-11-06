# 個人作品としての Mori Desk の導入・配布方針

更新日: 2026-11-06（Asia/Tokyo）。利用者の意図は個人の非商用作品であり、当面は自分の端末で試す。個人的に知る少数の人へ試験を広げる場合も、従来の配布計画に書いた署名・公証・Chrome Web Store 登録は、試験を始めるための必須条件ではない。

| 項目 | 自分の端末・少数の知人での試験 | 誰でも取得できる公開配布で追加検討すること |
| --- | --- | --- |
| Windows | 未署名の NSIS `.exe` をビルドして試せる。SmartScreen や Smart App Control で警告・ブロックされる場合があり、利用者本人が発行元と SHA-256 を確認する。OS の保護機能を自動で迂回しない。 | 署名は発行元確認と円滑なインストールのため推奨。非商用でも警告の有無は変わらない。署名済みでも新しいファイルの SmartScreen 警告が必ず消えるわけではない。 |
| macOS | Mac 実機で未署名・未公証の `.app`／DMG を試せる可能性がある。Gatekeeper が拒否した場合は利用者が Apple の手順に沿って個別に許可する。Mac 実機がない間は合否を主張しない。 | Developer ID 署名・公証は、Mac App Store 外から入れる人が Gatekeeper で確認しやすくするために検討する。これは商用かどうかで決まる条件ではない。 |
| Chrome 拡張 | Chrome のデベロッパーモードから unpacked 版を読み込める。Web Store 発行者登録は不要。Mori Desk との HMAC ペアリングは必要。 | Web Store 経由で導入・更新させるときに発行者登録と審査が必要。登録料がかかる。Web Store を使わない限定試験では保留できる。 |
| Google Cloud / OAuth | 本人管理のプロジェクトと Desktop OAuth を使う。Google は本人または個人的に知る少数ユーザーに対する制限付きスコープ審査の例外を説明している。External / Testing ではテストユーザー登録、警告画面、ユーザー数上限、通常7日の更新トークン失効がある。 | 無料・非商用という理由だけで審査免除にはならない。不特定多数が使えるようにする場合は、OAuth プロジェクトの公開状態、`gmail.readonly` の審査・例外適用、利用規約を再判定する。Workspace 管理者の制限も別に残る。 |
| kaduiro.com | Cloudflare Pages に案内ページを置くのに独立サーバーは不要。サイトを公開するだけなら OS 署名や Web Store 登録を要求されない。現時点ではダウンロードリンクを出していない。 | 取得先を載せるなら配布範囲を明示し、実ファイルの SHA-256、対象 OS、ソース・帰属、プライバシー説明、未署名・未公証の状態を正確に表示する。公開 URL は少数利用者だけに配ったつもりでも第三者がアクセスできる。 |

## 直近の実行順

1. 独立した Windows 環境が用意できたら、現行の未署名 Setup の SHA-256 を照合してインストール・再起動・アンインストールを試す。Docker の Linux コンテナーは Windows GUI インストールの代替にならない。隔離環境がない間はインストール試験を未実施と記す。
2. 利用者の Chrome では、既存の unpacked 拡張と個人 Cloud 設定を使い、Calendar／Gmail／HUD の接続を確認する。OAuth JSON とトークンを共有しない。
3. Mac 実機を使えるときに `.app`／DMG を生成して Gatekeeper と起動を本人が確認する。署名・公証のない版ならその状態を明示する。
4. 作品を広く配る判断をした時点で、Windows 署名、Mac Developer ID、公証、Web Store、Google OAuth の公開条件を改めて選ぶ。非商用という属性だけでこれらの条件を免除したとは扱わない。

公式資料: [Microsoft SmartScreen](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)、[Apple の未公証アプリを開く方法](https://support.apple.com/en-gb/102445)、[Chrome の unpacked 拡張](https://developer.chrome.com/docs/extensions/how-to/distribute)、[Google の個人利用例外](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)、[Google の Testing 更新トークン](https://developers.google.com/identity/protocols/oauth2)。
