# Mori Desk 配布・個人 Cloud 導入の残存タスクと実行順

更新日: 2026-11-06（Asia/Tokyo）。[初回の実装記録](desktop-distribution-implementation-20261106-ja.md)、[最新の受入記録](desktop-release-readiness-20261106-ja.md)と [PR #12](https://github.com/kaduiro/mori-desk/pull/12) を起点にする。PR #12 は CI 成功後に `main` へマージ済み。一般配布は未実施。以下の「現在の到達点」は初回候補の時点の記録であり、現在値は最新の受入記録に示す。

## 現在の到達点

- Windows x64 の NSIS Setup `.exe` はローカルで生成済み。ただしアプリ本体とインストーラーは未署名。インストール後のショートカット、異常終了後の再起動、ログイン時起動は未試験。
- Calendar・Gmail の個人 Cloud ガイドとビルド入口を実装済み。Cloud プロジェクトの請求状態・実効枠はアプリから検証できず、利用者が Console で確認する。
- `npm test` は900件中898成功、失敗0、スキップ1、TODO1。最後の HTML 配置変更後の対象7件も成功。生成 runtime のソース整合は通過し、元の常用 runtime は保持。
- 本番依存の `npm audit --omit=dev` は high 3件（`follow-redirects`、`js-yaml`、`markdown-it`）、moderate 1件（`qs`）。

## 実行順と合格条件

| 順 | 作業と成果物 | 着手条件 | 完了判定 |
| --- | --- | --- | --- |
| 1 | PR #12 の差分レビュー、CI 結果の確認、マージ。公開作業とは別にソースを `main` に反映する | 現在着手可能 | レビュー指摘を解消し、`main` に同じソースが反映される |
| 2 | 依存4件の更新。直接依存・推移依存の固定版を確認し、`patches/mori.patch` の `package.json` と lockfile に反映。再構築、`npm test`、`npm audit --omit=dev`、Windows 再ビルド | 現在着手可能 | high 0。moderate は影響と採否を記録。ソース整合と全回帰試験が成功 |
| 3 | Windows x64 の隔離環境でインストール試験。スタートメニュー／デスクトップ起動、通常終了、主プロセス異常終了後のアイコン起動、多重起動、HUD と認証設定の保持、ログイン時起動、更新、アンインストールを記録。ARM64 も別実機で試す | Windows の隔離ユーザーまたは VM。ARM64 実機は別途 | PowerShell や BAT なしで復旧でき、意図した終了後は勝手に再起動せず、保存済み設定が仕様どおり残る |
| 4 | レンダラー異常終了を分類し、対象画面だけ再生成する復旧処理と故障注入試験。主プロセスの即時無人再起動は別判断 | Windows 基本起動試験の結果 | HUD・設定画面の故障で主プロセスが残る場合、状態を失わず画面を再表示できる |
| 5 | 個人 Cloud セットアップの状態表示を仕上げる。利用者が Console で確認したプロジェクト ID、請求先の有無、確認日時・出所を「自己申告」として保存。API 無効、403／429、Testing 失効、Workspace 管理者拒否の案内と任意の gcloud 手順を整える | 現在着手可能。実 Cloud 確認は本人のアカウントで行う | JSON・トークンを共有せず、個人アカウントで Calendar／Gmail の接続・更新・再起動を試せる。未確認値を検証済みと表示しない |
| 6 | Chrome 拡張の権限・プライバシー申告を監査し、Web Store の限定テスター向け配布を試す。審査後の実 URL をアプリへ追加 | Web Store 発行者アカウント | 新規 Chrome プロファイルから導入、HMAC ペアリング、再起動後の復帰に合格 |
| 7 | Windows のコード署名と Mac の Developer ID 署名・公証・staple。Mac の `identity: "-"` を配布用設定から外す経路を用意し、x64／arm64 実機で検証 | Windows 署名資格情報、Mac 実機と Apple Developer ID／公証資格情報 | Windows の署名検証、Mac の Gatekeeper・公証検証、両 OS のインストール・起動・削除が成功 |
| 8 | Google OAuth の公開対象と `gmail.readonly` の審査または例外を判定。公開対象のアプリ名・ドメイン・プライバシー説明を整合させる | 公開主体とドメイン管理者の決定 | Google の公開条件を満たし、一般利用者が同意画面で接続できる。BYO 個人プロジェクトを審査代替として扱わない |
| 9 | `kaduiro.com` に検証済み版だけを掲載。OS／CPU 別の不変 URL、署名後 SHA-256、変更履歴、AGPL ソース・帰属、プライバシー説明、Chrome 拡張を掲載 | 2〜8 の公開ゲート合格とサイト公開担当 | 公開ページから取得したファイルのハッシュ、署名・公証、OS 起動試験が受入記録と一致 |

順1・2は完了し、4・5のソース部分も完了した。Windows の隔離インストール試験には VM または別ユーザーが必要。Mac、Web Store、OAuth 公開判定、サイト公開は担当者とアカウントが必要。Windows x64 の限定試験と個人 Cloud 導入は先行できるが、未署名ファイルを一般向けに配布しない。各項目の合否と未実施の範囲は[最新の受入記録](desktop-release-readiness-20261106-ja.md)に従う。

## 判断・提供が必要なもの

- Windows 署名の所有者と方法。署名の後でインストーラーの SHA-256 を確定する。
- Mac の x64／arm64 試験機、Apple Developer ID、公証資格情報。`.exe` は Mac 用形式ではなく、DMG と `.app` を作る。
- Chrome Web Store の発行者と限定テスター。公開 URL は審査後に確定する。
- `kaduiro.com` の更新権限を持つ担当者と、Google OAuth 公開主体・利用対象。個人の短期試験と一般配布を分けて判断する。
- 主プロセス異常終了直後の無人再起動を製品要件にするか。現行の必須条件は OS のアプリアイコンから一操作で起動できること。

## 試験記録の境界

OS／CPU、アプリ・拡張の版、非機密の Cloud プロジェクト ID、試験日時、操作と結果、失敗分類を残す。メール本文・予定本文・URL・OAuth JSON・認可コード・トークンは残さない。合成テスト、Windows／Mac 実機、Web Store 審査、Google OAuth 公開判断、サイト公開を別々に合否判定する。
