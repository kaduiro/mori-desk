# Gmail HUD の社内導入条件

2026-11-04。現時点で本番 Google Cloud プロジェクトは存在しない。個人の検証用プロジェクトで Gmail 同期と、同じ Chrome プロファイルに A/B をログインした状態での両アカウントのリンク動作は実機確認済み。結果は[個人検証記録](../../reports/gmail-personal-live-test-20261104-ja.md)にまとめた。以下の本番枠・課金・組織管理者の条件は、本番プロジェクト作成後に確認する。

## Cloud プロジェクトと利用枠

1. Google Workspace または Cloud Identity の**組織所有**プロジェクトを本番用に作る。検証用プロジェクトとは分け、Gmail API だけを有効化する。プロジェクト ID、所有組織、担当者、作成日を導入記録へ残す。
2. Cloud Console の「Quotas & System Limits」で Gmail API の **per minute per user per project**、**per minute per project**、1日の課金閾値を実画面で確認し、スクリーンショットと確認日を残す。2026-11-04 の[公式表](https://developers.google.com/workspace/gmail/api/reference/quota)は新規プロジェクトの参考値として 6,000 units/ユーザー/分、1,200,000 units/プロジェクト/分、80,000,000 units/プロジェクト/24時間を示すが、実効値は作成したプロジェクトで確認する。
3. Cloud Billing の紐付け状態、請求先、予算通知の受信者を記録する。予算アラートだけでは利用や支払いを自動停止しない。[Cloud Billing の予算説明](https://docs.cloud.google.com/billing/docs/how-to/budgets)に従い、利用量・請求の通知を担当者へ設定する。料金条件が変更された場合は配布判断を再実施する。
4. 想定社員数を `N`、1人1日の新着数を `M`、詳細を開く回数を `D`、手動更新回数を `R` とし、概算 `N × (576 + 20M + 60D + 2R)` units/日を記録する。初回100件の取得には別途約2,005 units/人が必要。端末のローカル上限は20,000 units/24時間、2,500 units/分であり、プロジェクト全体の上限にはならない。配布初日は接続を段階的に行い、Cloud 側の利用量と 429/403 を監視する。

## OAuth と社内配布

1. 同じ組織所有プロジェクトの OAuth consent screen を **Internal** に設定する。Internal は組織内アカウントだけに使える。別組織・個人 Gmail へ配布するなら、この前提で審査不要とは判断しない。[Google の例外条件](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)を確認する。
2. Gmail 専用の **Desktop app** OAuth client を作成し、JSON を配布する。Mori Desk はシステムブラウザー、PKCE、127.0.0.1 のループバック応答を使う。[Desktop app の認可フロー](https://developers.google.com/identity/protocols/oauth2/native-app)。クライアントシークレットはデスクトップ配布物に含まれる公開クライアント情報として扱い、サーバーの秘密鍵と見なさない。
3. OAuth の Data access に `https://www.googleapis.com/auth/gmail.readonly` だけを宣言する。これは[制限付きスコープ](https://developers.google.com/workspace/gmail/api/auth/scopes)。組織内利用の例外に合致すること、組織管理者が当該クライアント ID とスコープを承認する必要があるかを管理者と確認し、判断者・日付・根拠を記録する。ドメイン全体の代理権限は使わない。
4. 社員の同意画面に表示されるアプリ名・権限・発行元を実機で確認する。管理者ポリシーによる拒否、同意拒否、更新トークン失効、安全な保存領域がない場合を検証する。メール本文と更新トークンをサーバーへ送らない構成を維持する。

## 複数アカウントでの Gmail リンク

Gmail API は Web メールの URL を返さない。HUD は認可された `getProfile.emailAddress` とスレッド ID を使い `https://mail.google.com/mail/?authuser=<account>#all/<threadId>` を生成する。この画面形式は Gmail API の契約ではない。

Chrome で検証用アカウント A と B の両方にログインし、以下を行う。個人検証では A は `/mail/u/0/`、B は `/mail/u/1/` として各 HUD の実在スレッドを正しく開いた。以前の誤入力アドレスを `authuser` に指定した IAB の試行では、Gmail が A へフォールバックした。正しいアカウントをログアウトした場合の安全性は未確認。メールの件名・本文・アドレスは配布判定の記録に残さず、成否を記す。

| 操作 | 合格条件 | 個人検証の結果 |
| --- | --- | --- |
| A を HUD に連携し、A のメールの URL を開く | A の対象メールが開く | 成功。B もログインした Chrome で A の対象スレッドを確認 |
| B を HUD に連携し、B のメールの URL を開く | B の対象メールが開く | 成功。A もログインした Chrome で B の対象スレッドを確認 |
| Chrome のアクティブ Gmail を B に切り替えて A の URL を再度開く | A の対象メールが開く | 未実施 |
| A と B のログイン順を逆にして開く | URL が指定するアカウントの対象メールが開く | 未実施 |
| 対象アカウントのログインを外して URL を開く | 別アカウントのメールを開かず、安全に失敗する | 未実施。誤入力アドレス指定時の IAB では A へフォールバックする例を確認 |

合格まで社員向けに深いリンクの正確性を保証しない。誤ルーティングがあれば、アカウントを明示した Gmail の入口へ誘導する方式に切り替え、深いリンクの「Gmail で開く」と URL コピーを無効にする。テスト記録にはブラウザーのバージョン、検証日、Mori Desk のソース版、各行の成否を残す。

## 配布判定

Cloud プロジェクトの実際の枠・課金設定、Internal の対象組織と管理者承認、Chrome での対象アカウント未ログイン時を含むリンク試験、Gmail API の実データ同期、Windows の GUI 操作を本番条件で確認してから社内配布する。個人検証では A/B の同期と同一 Chrome での実在リンクを確認したが、本番の設定・配布判定は未完了。
