# Mori Desk 配布候補の受入記録

更新日: 2026-11-06（Asia/Tokyo）。[PR #12](https://github.com/kaduiro/mori-desk/pull/12) は GitHub Actions 成功後、`main` の `5f1b31d8e9a3e84b2b9bcabc399773da3faae10f` にマージ済み。この記録はローカル候補の状態を示し、一般配布の承認ではない。

## 今回完了したこと

| 項目 | 結果と境界 |
| --- | --- |
| 依存更新 | `follow-redirects` 1.16.2、`js-yaml` 4.3.2、`markdown-it` 15.0.3、`qs` 6.17.1 を lockfile に固定。再構築後の `npm audit --omit=dev` は high・moderate を含めて0件。Electron 41.10.4 など開発依存を含む監査は11件のままで、配布される Electron 自体の評価が必要。`--omit=dev` の0件をアプリ全体の安全性と同一視しない。 |
| ソースと回帰 | 独立 worktree で `npm run setup` 成功、`npm run doctor -- --json` は `source_check_passes (source_matches)`。`npm test` は901件中899成功、失敗0、skip 1、TODO 1。レンダラー復旧と個人 Cloud の状態保存を含む。 |
| Windows x64 | `npm run build:win:x64` 成功。`Mori-Desk-Setup-0.1.3-preview.1-x64.exe` は111,262,848 bytes、SHA-256 `8D15421187825E332D9615BDEA6F01C785E6F24AFE4CBEB193A4B2982EA56CB1`。Setup と本体の Authenticode はいずれも `NotSigned`。このハッシュは署名前のローカル候補だけに有効。 |
| Chrome 拡張 | Mori 生成アイコン16／48／128 pxを追加。24ファイルだけを含む未提出の Web Store レビュー用 ZIP を生成（76,762 bytes、SHA-256 `F6092E89E54DFDECA883FFCE05A14F2431720222FB8AE44EC958C392753D827F`）。拡張 ID は開発用の固定 ID のまま。新規 Web Store item の ID が確定したら、拡張の公開鍵とデスクトップ側の厳密な Origin 許可を一緒に更新する。 |
| HUD 復旧 | Calendar と Gmail のレンダラーが異常終了した場合だけ同じ画面を再読み込みする。60秒に最大2回で停止し、閉じた窓や正常終了は再読み込みしない。主プロセスが終了した場合の無人再起動は含まない。 |
| 個人 Cloud | プロジェクト ID、請求先状態、Gmail／Calendar 枠の確認有無を本人申告として端末内に保存。確認日時と出所を表示し、OAuth JSON・トークンはこの記録に含めない。403、429、Testing 失効、Workspace 管理者制限の確認手順をガイドに追加。実 Cloud の所有・課金・枠をアプリが検証した結果ではない。 |

元の常用 worktree の runtime は保持した。独立 worktree の runtime ファイルも再構築で生成し直したうえで、次回起動のソース整合を別に確認した。常用 worktree は別のローカルブランチに残してあり、今回の `main` マージをその実行中アプリに適用したわけではない。`doctor` の整合はインストール後の実起動を証明しない。

## Windows 隔離試験の現状

利用者は Windows VM を想定していたが、この PC では VM 操作アプリ、Windows Sandbox、Hyper-V の接続アプリを確認できなかった。Docker Desktop は存在するが、稼働エンジンは Linux コンテナー。Docker コンテナーでは NSIS の Windows GUI インストール、スタートメニュー、ログイン項目、異常終了後のアイコン起動、アンインストール UI の受入を代替できない。

隔離 Windows 環境が得られたら、クリーンユーザーで次を記録する。Windows の保護機能や署名検査は無効化しない。

1. Setup の SHA-256 と署名を確認し、通常のインストール画面から導入する。
2. スタートメニュー・デスクトップ・検索から起動し、複数回起動して単一インスタンスを確認する。
3. Calendar／Gmail の HUD を開き、倍率・位置・サイズ・起動時表示を保存して再起動する。OAuth の秘密値やメール本文を記録しない。
4. 通常終了後は勝手に再起動しないこと、主プロセス異常終了後はアプリアイコンから再起動できることを確認する。
5. ログイン時起動をアプリ設定でオン・オフし、OS ログイン後の動作を確認する。上書き更新とアンインストール後のデータ保持範囲を確認する。
6. レンダラー故障注入は別の開発用プロファイルで行い、2回の復旧上限と保存済み設定の保持を観察する。

## kaduiro.com の配置

ドメインは Cloudflare で保持しているが、サーバーは不要。案内ページは Cloudflare Pages の静的サイトとして用意し、署名済みインストーラーは版ごとに GitHub Releases へ置く案を採用する。Pages の単一ファイルは25 MiBまでで、今回の約111 MBの Setup を直接置けない。GitHub Releases は1ファイル2 GiB未満で、リリース全体の容量・帯域に上限を設けていない。独自のバイナリ用ドメインが必要になった場合だけ Cloudflare R2 を検討する。R2 は無料枠を超えると課金され、利用開始には subscription 設定が必要。

Pages の公開設定は `kaduiro.com` の Cloudflare 権限を持つ本人が行う。署名済み Windows／公証済み Mac の成果物がない段階では、ダウンロード可能と表示しない。公開ページには OS／CPU、版、不変の GitHub Release asset URL、署名後の SHA-256、変更履歴、AGPL ソースと帰属、プライバシー説明、拡張の Web Store URL を載せる。アプリからの自動更新は有効化しない。

## Chrome Web Store の申告案

- 目的: 対応する ChatGPT／Claude タブの生成状態と短い表示用メタデータを、ペアリング済みの同一 PC の Mori Desk HUD に表示する。
- ホスト権限: `chatgpt.com` と `claude.ai` のみ。`storage` は端末内設定と接続情報、`alarms` は接続・監視の定期確認、`scripting` は対応タブ内の同梱監視コードの再配置に使用する。
- 端末へ送るデータ: 確認済みの会話タイトルと直近の送信済み利用者依頼の抜粋をそれぞれ最大160 UTF-16コード単位、状態、件数、対象タブを識別するための値。未送信文、回答全文、会話履歴、HTML、Cookie、APIキーは収集しない。診断は分類と件数だけにする。
- 保存と転送: 拡張の接続鍵は Chrome のローカル保存に制限し、同一 PC の loopback WebSocket を HMAC 相互認証して端末内 HUD に送る。Mori Desk の Google API 連携はデスクトップ本体の別機能であり、拡張に Gmail 権限はない。
- 公開前: Web Store の申告とプライバシー説明を実コードに照合し、発行者アカウント、ストアの画像、審査、実 ID、Private テスター、新規 Chrome プロファイルでのペアリング・再起動試験を完了する。発行者登録には一度限りの登録料が必要。

## 公開ゲート

- **Windows:** 証明書の所有者、Authenticode 署名、隔離 Windows インストール試験、配布版 Electron の脆弱性評価。未署名 Setup の一般配布は行わない。
- **macOS:** Mac 実機、Apple Developer ID、署名・公証・staple、x64／arm64 の Gatekeeper と起動試験。Mac の `.exe` は作らない。
- **拡張:** Chrome Web Store 発行者登録、プライバシー申告と審査、実 ID への厳密な Origin 設定の更新、実 Chrome 試験。
- **Google:** Gmail `gmail.readonly` は制限付きスコープ。本人や少数の個人的な試験と不特定多数の一般公開を区別し、対象・公開状態・必要な Google 審査または例外を確定する。利用者の個人 Cloud プロジェクトだけで審査を回避できると表示しない。
- **サイト:** Cloudflare Pages の管理権限、署名・公証済みの不変成果物、公開ページとプライバシー説明の最終照合。

公式資料: [Cloudflare Pages の上限](https://developers.cloudflare.com/pages/platform/limits/)、[GitHub Releases の上限](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[R2 の料金](https://developers.cloudflare.com/r2/pricing/)、[Chrome Web Store の開発者登録](https://developer.chrome.com/docs/webstore/register)、[Chrome Web Store の利用者データポリシー](https://developer.chrome.com/docs/webstore/program-policies/policies)、[Google の Gmail スコープ](https://developers.google.com/workspace/gmail/api/auth/scopes)。
