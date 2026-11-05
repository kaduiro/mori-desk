# HUD 起動設定と法人先行試験の実行手順

更新: 2026-11-04。対象候補はユーザーが指定した `masterkey-inc.com`。このドメインが Google Workspace / Cloud Identity の同一組織に属するか、管理者窓口、本番 Cloud プロジェクトの作成者と時期は未確認。個人検証用 Cloud プロジェクトを法人用に流用しない。

## 現在までに確認したこと

- 個人の A/B アカウントでは Mori Desk の Gmail 同期、詳細、手動更新、Chrome での両アカウントのリンクを試験済み。Mori Desk は A に再連携済み。
- 利用対象ブラウザーは Chrome に限定する。A/B の両方にログイン済みの Chrome では、それぞれの HUD リンクが対象プロフィールとスレッドへ到達した。対象アカウントだけが Chrome で未ログインの条件は未試験であり、Chrome のリンク受入はまだ完了していない。件名や本文は記録しない。
- Brave と IAB での観察は個人試験の履歴として残すが、Chrome 限定の合否判定には使わない。法人先行試験では Chrome のプロフィール一致を確認し、対象アカウントが未ログインなら別アカウントのメールを開かずログイン案内になるかを検証する。誤遷移した場合は、社内配布前に深いリンク操作を無効化し、アカウントと件名による手動確認へ切り替える。
- 両 HUD の「起動時に表示」は既定でオン。各 HUD の下部で個別に変更し、次回起動から適用する。オフの HUD は自動同期も開始しない。右クリックメニューから手動で開くことはできる。未連携の Mail HUD もオンなら連携案内とともに開く。
- この変更の通常ランタイムを `npm run rebuild` で再構築。両 HUD の実行ファイルが再構築後に存在する。`npm test` は 896 件中 894 成功、失敗 0、スキップ 1、todo 1、終了コード 0。`npm run doctor` は `source_check_passes (source_matches)`。Windows 実機で再起動後に「受信メール」と「今日の予定」の両ウィンドウが開いていることを確認した。設定を実機 UI でオフにしてからの再起動試験は未実施で、個別の保存・再読み込みと送信元検証は自動テストで確認した。ランタイムファイルの存在と次回起動のソース整合は別々に確認した。

## 工程と担当

| 工程 | 担当と入力 | 実施内容 | 完了証跡・判断 |
| --- | --- | --- | --- |
| 1. 組織と利用者の確定 | `masterkey-inc.com` の Workspace 管理者、社内の依頼者 | 同一組織の管理下にあるドメインか、対象の組織部門、先行利用者1～2人、Cloud プロジェクト作成者・課金管理者・セキュリティ承認者を指名 | 管理者窓口と対象者を記録。現在は未定のため法人の OAuth 設定は未開始 |
| 2. 本番 Cloud 準備 | 組織所有の Cloud プロジェクトと権限 | Calendar/Gmail 用の API と Desktop OAuth クライアントを分ける。組織内利用なら Internal の可否を確認。Calendar は予定・カレンダー一覧の読み取り、Gmail は `gmail.readonly` のみを要求する | プロジェクト ID、所有組織、クライアント ID、同意画面の利用者区分、要求スコープ。秘密情報を記録・配布しない |
| 3. 管理者のアクセス制御 | Workspace 管理者 | 管理コンソールの API controls でクライアント ID を検索。対象組織部門と必要スコープだけの `Specific Google data` を優先して設定し、実ユーザーの同意可否を試す | 承認者、日付、対象組織部門、許可スコープ、拒否時の表示。`Trusted` による全スコープ許可を既定にしない |
| 4. 実利用枠と課金 | Cloud/課金管理者 | 各本番プロジェクトの Quotas & System Limits と API Metrics、Billing のリンク有無、請求先、予算通知先と閾値を確認。試験中は 403/429、1分・24時間の使用量を監視 | 画面上の実効枠と確認日、請求先の状態、予算通知担当を記録。予算通知は支出を自動停止しない |
| 5. 法人先行試験 | 承認済みの利用者1～2人と実装担当 | 独立した Windows PC/Chrome プロファイルで初回連携、再起動、両 HUD の起動設定オン/オフ、予定とメールの更新・詳細、5分同期、OAuth 失効・拒否、対象アカウントにログイン済み・未ログインの Chrome リンクを試す。7～14日、API使用量とエラーの件数だけを観察 | Chrome で誤アカウント表示なし、同期遅延と操作性を許容、課金・権限・配布物の審査が完了。本文や予定内容を検証記録へ転記しない |
| 6. 配布判定 | 社内責任者 | 実ビルド、署名、OS 信頼、更新・復旧、セキュリティレビューと法人試験の結果を照合 | 未合格のリンクは無効化。個人検証用 OAuth JSON・トークン・キャッシュを配布物に含めない |

## 公開値と実測の区別

2026-11-04 時点の Google 公開値では、新規プロジェクトの Gmail は 1,200,000 units/分/プロジェクト、6,000 units/分/ユーザー/プロジェクト、80,000,000 units/24時間/プロジェクトの課金閾値。Calendar は 10,000 requests/分/プロジェクト、600 requests/分/ユーザー/プロジェクト、1,000,000 requests/24時間/プロジェクトの課金閾値。どちらも将来の閾値超過課金が予告されているため、公開値を本番の実効枠や確定料金として扱わない。プロジェクト作成後に Cloud Console で再確認する。[Gmail 利用枠](https://developers.google.com/workspace/gmail/api/reference/quota)、[Calendar 利用枠](https://developers.google.com/workspace/calendar/api/guides/quota)、[Workspace の変更予定](https://developers.google.com/workspace/tools-safety)。

Gmail はデスクトップ端末での取得にポーリング同期が推奨されている。現行の5分差分同期と手動更新を先行試験で実測し、端末内の上限だけで法人全体の合計を保証しない。[Gmail push の説明](https://developers.google.com/workspace/gmail/api/guides/push)。組織所有・Internal の検証例外と、管理者側のアプリ制御は別の確認事項。[OAuth の条件](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)、[Workspace 管理者のアプリ制御](https://knowledge.workspace.google.com/admin/apps/control-which-apps-access-google-workspace-data)、[予算通知](https://docs.cloud.google.com/billing/docs/how-to/budgets)。
