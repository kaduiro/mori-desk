# Mori Desk のデスクトップ配布・復旧・個人 Google Cloud 導入計画

策定日: 2026-11-06（Asia/Tokyo）
状態: Windows x64 の未署名インストーラーと個人 Cloud ガイドまで実装。[実装記録](desktop-distribution-implementation-20261106-ja.md)を参照。署名済みインストーラー、Mac 実機、公開サイト、各利用者の Cloud プロジェクトの受入は未完了。

この文書の署名・公証・Web Store に関する公開ゲートは、不特定多数への円滑な配布を想定した案。個人の非商用作品として自分と少数の知人で試す現在の方針には、[個人利用の導入・配布方針](personal-use-distribution-20261106-ja.md)を優先する。非商用という理由だけで Google OAuth や OS の条件が自動的に免除されるわけではない。

現在の優先順と合格条件は[残存タスクの実行案](desktop-distribution-next-steps-20261106-ja.md)に記載。

## 目的と前提

- 利用者は PowerShell、シェル、Node.js、Git を使わず、Windows ではインストールした Mori Desk のアイコン、macOS では `.app` から起動・再起動できる。
- `kaduiro.com` を配布入口とする。Windows にはアーキテクチャ別の Setup `.exe`、macOS にはアーキテクチャ別の `.dmg` とその中の `.app` を提供する。Mac 用の `.exe` は作らない。
- Google 連携の基本形は、利用者本人が管理する Google Cloud プロジェクトと Desktop OAuth クライアントを Mori Desk に取り込む方式とする。通常の Gmail 差分同期は端末上で行い、Cloud Run や Pub/Sub は導入しない。
- 「個人の無料枠」は無条件の無償保証ではない。Google の公開条件、実プロジェクトの利用枠、請求先の有無を導入時に確認する。Google Workspace アカウントでは、個人所有プロジェクトでも組織管理者の制限が残る。
- 通常起動は従来どおりブラウザー中心。CLI 連携は明示的な `--enable-cli` が必要。既存の Mori のデータ領域、手動更新の所有権、AGPL と帰属表示、Chrome 拡張の HMAC ペアリングを維持する。

## 現状と差分

| 項目 | 現状 | 完了するための差分 |
| --- | --- | --- |
| OS からの起動 | ソース版は BAT／npm から起動。Windows NSIS と Mac DMG のビルド設定はある | 実インストーラーを作り、Windows のスタートメニュー・アンインストール一覧、Mac の Applications／Spotlight から起動できることを実機で確認。Mac の Dock 表示は任意設定として試験 |
| ログイン時起動 | 設定と OS 登録の所有者確認コードがある | インストール版で有効化・無効化・OS 側での無効化・ログイン後の起動を両 OS で確認 |
| 異常終了後の復帰 | 次の OS ログイン時起動と、アプリの主プロセスが存命な場合の復旧は別の話 | まずアイコンから一操作で再起動できることを P0 とする。主プロセスの即時自動再起動を要件に含めるなら、独立監視機構を別工程で設計・実機試験 |
| 公開物 | `publish: null`、Mac は開発用の `identity: "-"`、署名済み公開物なし | Windows 署名、Mac Developer ID 署名・公証、配布物の検証、サイト掲載 |
| Chrome 拡張 | 開発時は unpacked を手動で読み込む | Chrome Web Store の配布と、アプリ内のインストール・ペアリング案内を追加。デスクトップのインストーラーから黙って導入しない |
| Google OAuth | Calendar と Gmail の Desktop OAuth JSON を別々に取り込む。個人検証済み | 各利用者向けの案内・状態診断・認可後の確認を作る。Testing の 7 日失効と Workspace 制限を明示 |

現行の主な所有箇所: `scripts/run.js`、`patches/mori.patch` の `package.json` と `src/main.js` の差分、`overlay/src/mori-login-item.js`、`overlay/src/mori-calendar-api.js`、`overlay/src/mori-mail-api.js`。実装時は生成物 `.runtime/` を最終ソースとして編集しない。

## 工程 A: インストールと起動復旧

1. **配布用の起動経路を確定する。** Windows の NSIS x64／ARM64、Mac の DMG x64／arm64 を同じタグのソースから作る。現行のソース版 `scripts/run.js` は Windows ビルドのみ受け付けるため、Mac runner の配布用入口も明示的に追加する。インストール後の実行ファイルは固定した製品 ID と Mori 専用データ領域を使う。ソース版の startup guard は開発用として維持し、配布版は埋め込みの build 情報と署名済み成果物を確認する。
2. **OS にアプリとして登録する。** Windows のスタートメニュー、検索、アンインストール一覧、Mac の Applications と Spotlight から通常起動する。現行 Mac 設定は `LSUIElement: true` で Dock 常駐を前提にしないため、Dock は利用者が表示を有効にした場合だけ試験する。インストール時にログイン時起動を勝手に有効化せず、既存のアプリ設定から本人が切り替える。多重起動では既存の Mori を前面に出す。
3. **主プロセスと画面の故障を分ける。** レンダラーが落ちた場合は `render-process-gone` 等を分類し、対象画面だけを安全に再生成する。アプリ全体が落ちた場合は OS のアイコンから再起動できることを最初の受入条件とする。トレイ表示だけで「正常稼働」と判定しない。
4. **即時自動再起動は別の受入ゲートに置く。** 必要性が実測で確認された場合に限り、アプリ本体とは別の OS 管理下の監視プロセス／ログイン項目を検討する。明示的な終了、アンインストール、更新中は再起動しない。連続失敗は上限回数で止め、失敗理由を見せる。自己再起動の無限ループや、OS 保護機能の迂回を許さない。

**A の合格条件:** インストール直後、アプリ終了後、主プロセスの異常終了後、OS ログイン後に、シェルを使わず起動できる。両 HUD の起動時表示設定、位置、倍率、連携状態が保持される。意図的な終了では勝手に復帰しない。

## 工程 B: 配布物と `kaduiro.com`

1. 固定した上流・パッチ・overlay から CI で再構築し、Node 24.18+ の 24.x で `npm test` の個別アサーションと終了状態を確認する。素材・AGPL・帰属・ネイティブ依存の監査を通す。
2. Windows runner で x64／ARM64 の NSIS をビルドし、配布用証明書で署名して署名検証を行う。Mac runner で x64／arm64 の DMG をビルドし、Developer ID 署名、hardened runtime、公証、staple の検証を行う。証明書・公証の資格情報は CI の保護された秘密情報として管理し、リポジトリやログへ出さない。署名・公証が欠けた成果物は公開候補にしない。
3. 実機で新規インストール、起動、ログイン時起動、上書き更新、アンインストールを確認する。保存済みの設定・OAuth 連携の保持／削除範囲を仕様どおりに確認する。Windows SmartScreen と Mac Gatekeeper を無効化して合格扱いにしない。
4. 公開担当者が検証済み成果物だけを `kaduiro.com` のダウンロードページへ昇格させる。ただし Gmail・Calendar を有効にした一般配布は、工程 D の OAuth 公開判定を満たすまで行わない。OS・CPU・版・公開日、SHA-256、署名確認方法、変更履歴、AGPL ソースと帰属、プライバシー説明、Chrome 拡張の導線を並べる。URL とファイル名は版ごとに固定し、同じ名前で別バイトを上書きしない。今回のプレビューは従来どおり手動更新とし、リリースダウンロードをアプリが自動実行する仕組みは追加しない。

**B の合格条件:** 公開ページのリンクから取得したファイルが CI で検証した SHA-256 と一致し、対応 OS の信頼機構で署名・公証を確認でき、シェルなしでインストール・起動・削除できる。工程 D の OAuth 公開判定も通っている。実際のバイナリが完成するまで「ダウンロード可能」と表記しない。

## 工程 C: Chrome 拡張の一般向け導入

1. 拡張の権限、収集・保存する情報、HMAC ペアリング、サイト別の監視状態を Chrome Web Store の申告と照合する。
2. 先行試験は指定テスターだけが導入できる Chrome Web Store の Private listing を使う。一般配布では URL を知る人が導入できる Unlisted、または Public listing を選び、審査を受ける。利用者が Chrome 上で明示的に追加する。開発用 unpacked の手順は開発者向けに残す。
3. アプリ初回起動時には Web Store へのリンク、接続コード、接続状態、版の不一致の案内を出す。拡張がなくても Calendar・Gmail の独立した機能を使えるようにする。

**C の合格条件:** 新規 Chrome プロファイルで Web Store から導入・ペアリング・再起動後の復帰を確認する。Windows／Mac のローカル CRX 自動導入やブラウザーポリシーの迂回に依存しない。

## 工程 D: 各利用者の Google Cloud セルフセットアップ

**推奨方式はアプリ内ガイド＋必要箇所だけのエージェント支援。** プロンプトのみでは Cloud Console の変更に弱く、IaC のみでは通常の OAuth クライアント作成を完結できない。Google の現行ガイドは OAuth クライアントの作成・変更を Cloud Console で手動で行うよう求めている。

1. アプリに「Google 連携の準備」画面を設け、個人 Google アカウント、Google Workspace アカウント、既存プロジェクト利用を区別する。プロジェクト ID と請求先の有無は、本人が Cloud Console で確認した値として、確認日時・出所とともに記録する。アプリ単独で確認できない場合は「未確認」と表示する。Mori は Cloud 管理権限を要求しない。
2. 必要な API は Gmail API と Calendar API のみに限定する。プロジェクト作成、API 有効化、利用枠の読み取りは、利用者が選んだ場合だけ gcloud／IaC の手順やエージェント支援を提供する。実行前に対象プロジェクトと変更内容を表示し、請求先の新規連携や割り当て増加は自動で行わない。
3. OAuth 同意画面の対象ユーザー、公開状態、連絡先、スコープを利用者が Cloud Console で確認する。現行コードに合わせ、Calendar 用と Gmail 用の Desktop OAuth クライアント JSON をそれぞれ作成・取り込む。Gmail は `gmail.readonly`、Calendar は `calendar.events.readonly` と `calendar.calendarlist.readonly` を宣言する。JSON をチャット、ログ、リポジトリ、`kaduiro.com` へ送らない。
4. アプリが JSON の Desktop client 構造、クライアント ID 形式、必要フィールドを検証する。JSON 単体では Cloud プロジェクトの所有者を証明できないため「発行元を検証済み」と表示しない。認可・トークン・API の通信先はコード内の固定した Google URL を使い、取り込んだ JSON の URL を採用しない。認可はシステムブラウザーと PKCE／loopback を使う。トークンは OS の保護された保存領域を使い、保護できなければ接続を止める。認可と API 応答で接続先アカウントを確認した後、API 有効化、初回同期、Chrome の Gmail リンクを本人が確認する。
5. `External / Testing` はテスター登録が必要で、Gmail 等の権限を使う更新トークンが通常 7 日で失効する。短期試験用と明示し、継続利用の設定とは扱わない。`gmail.readonly` は制限付きスコープであり、Google の個人利用例外は本人か個人的に知る少数の利用者が対象。利用者ごとの BYO プロジェクトを一般配布の審査代替と扱わない。`kaduiro.com` から不特定多数へ Google 連携を提供する前に、対象者・OAuth クライアントの所有者・例外の適用可否・必要な Google 審査を確定する。判断が未了なら Google 連携を含む一般公開を保留する。Google Workspace のメールを接続する場合は、プロジェクトの所有者にかかわらず管理者の制限を確認する。
6. 端末の Gmail 5 分差分同期、手動更新のクールダウン、ローカル利用量台帳と backoff を維持する。新規プロジェクトの実効 API 枠・請求条件を Cloud Console で確認し、403／429、失効、オフライン、初回大量同期を検証する。追加のサーバーを建てないことで固定費とサーバー上の制限付きデータを増やさない。

**D の合格条件:** 新しい個人用プロジェクトで、秘密情報を共有・コミットせずに両 API を有効化し、Calendar と Gmail を連携・更新・再起動後に利用できる。Testing の 7 日失効、Workspace 管理者拒否、無効な JSON、API 無効、枠超過で原因と対処を表示する。JSON の出所を検証できたと偽らず、接続先アカウントを API 応答で確かめる。無料利用を保証する表示はしない。一般公開には前項の OAuth 公開判定を追加で要求する。

### Codex／Claude に渡す案内文の要件

案内文は製品に同梱し、現行の Google 公式手順へのリンクと次の制約を含める。エージェントには手順確認、画面の誘導、非機密の設定値の照合、完了後の検査を任せる。本人の Google ログイン、規約・請求先・OAuth 権限への同意は本人に引き継ぐ。ブラウザー・OS の警告や企業ポリシーを迂回しない。認可コード、更新トークン、OAuth JSON の内容をチャットへ貼らせない。エージェントが操作できない環境でも同じ導入手順を人間だけで完了できるようにする。

## 依存関係と実施順

| 順 | 作業 | 次へ進む条件 |
| --- | --- | --- |
| 0 | 配布対象 OS／CPU、署名の所有者、`kaduiro.com` の公開担当、Chrome Web Store の発行者、Google 連携の公開対象を決める | 各資格情報の所有者と公開責任者、OAuth 公開判定の担当者が決まる |
| 1 | Windows インストーラーとアイコンからの復帰を完成させる | Windows 実機の新規インストール・異常終了・再起動試験に合格 |
| 2 | Mac の署名・公証付き DMG を完成させる | macOS x64／arm64 実機で Gatekeeper・起動・ログイン時起動に合格 |
| 3 | Chrome Web Store と初回ペアリング導線を完成させる | 新規 Chrome プロファイルで導入・接続に合格 |
| 4 | Google セルフセットアップ画面、案内文、任意の部分 IaC を完成させる | 個人アカウントと Workspace 制限の試験に合格 |
| 5 | 署名済み成果物をサイトへ昇格させる | SHA-256、署名、公証、AGPL、プライバシー、リンク、OAuth 審査・例外の適用判断の最終照合に合格 |

工程 1〜4 は並行開発できるが、公開ゲート 5 は全工程の実機結果を待つ。法人アカウントの利用を復活させる場合は、組織の管理者承認を別のゲートに置く。

## 試験記録と未決事項

受入記録は OS／CPU／Chrome 版、アプリと拡張の版、Cloud プロジェクトの非機密 ID、試験日、合否、失敗分類を残す。メール本文、予定本文、URL、OAuth JSON、トークンは記録しない。合成テスト、Windows 実機、Mac 実機、Web Store 審査、署名・公証、サイト公開を別々の結果として扱う。

未決事項は以下の三つ。実装時には既定案を採用し、変更理由を記録する。

1. **異常終了直後の自動再起動:** 当面は OS のアプリアイコンからの手動再起動を必須とし、無人復旧は実測後に判断する。
2. **個人 GCP の対象:** 一人一プロジェクトを試験の既定とする。共有の個人プロジェクトを複数利用者へ配ることは、OAuth の審査・枠・管理責任を別途確認するまで採用しない。
3. **公開形態:** 初回は手動更新の署名済みプレビューを候補とし、自動更新は別の設計・承認・試験を要する。

## 独立レビューと反映

2026-11-06 にサブエージェントが現行ソースと公式一次資料を独立に照合した。公開前の OAuth 判定、Mac の `LSUIElement` による Dock 表示、請求先確認の出所、OAuth JSON の検証可能範囲、Chrome Web Store の Private／Unlisted の違いを指摘し、上記の公開ゲートと各工程へ反映した。レビューは実インストーラーや Cloud Console の操作試験ではない。

## 公式根拠（2026-11-06 確認）

- Google OAuth [ベストプラクティス](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)、[公開状態と対象ユーザー](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)、[制限付きスコープの例外](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)、[更新トークンの失効](https://developers.google.com/identity/protocols/oauth2/)
- Gmail [権限の分類](https://developers.google.com/workspace/gmail/api/auth/scopes)、[利用枠と料金](https://developers.google.com/workspace/gmail/api/reference/quota)、Calendar [利用枠](https://developers.google.com/workspace/calendar/api/guides/quota)
- Chrome [拡張機能の配布](https://developer.chrome.com/docs/extensions/how-to/distribute)、[Web Store の公開範囲](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- Electron [ログイン時起動 API](https://www.electronjs.org/docs/latest/api/app)、[レンダラー異常終了](https://www.electronjs.org/docs/latest/api/web-contents)、[配布の概要](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)
- Apple [Mac アプリの公証](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、Microsoft [Windows SmartScreen と署名](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)
