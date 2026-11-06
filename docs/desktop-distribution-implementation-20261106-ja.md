# デスクトップ配布と個人 Google Cloud 導入の実装記録

記録日: 2026-11-06（Asia/Tokyo）。[実装計画](desktop-distribution-personal-cloud-plan-20261106-ja.md)のうち、初回 Windows 候補の記録です。依存更新後の新しい候補、復旧、個人 Cloud 状態表示、Web Store の準備は[最新の受入記録](desktop-release-readiness-20261106-ja.md)を参照してください。

## 実装した内容

- Windows x64／ARM64、macOS x64／arm64 のソース側ビルド入口を追加し、異なる OS からの誤実行を拒否する。
- NSIS のスタートメニューとデスクトップのショートカット作成を明示した。インストーラーとアプリの製品名は Mori Desk。ユーザーデータをアンインストール時に自動削除しない既存方針を維持した。
- Calendar 設定と Gmail HUD の設定に「個人 Google Cloud の準備方法」を追加した。画面には必要 API、Desktop OAuth、スコープ、Testing の失効、Workspace 制限、実効枠、秘密情報の扱い、Codex／Claude 支援用の案内文を載せた。外部リンクは固定した Google 公式 URL だけを開く。
- [人手でも進められる導入手順](personal-google-cloud-setup-ja.md)を追加した。OAuth JSON とトークンは同梱・公開しない。

## 検証結果

| 項目 | 結果 |
| --- | --- |
| 生成元からの再構築 | 成功。Node 24.21.0、Electron 41.10.4。元の常用 runtime は触れず、独立 worktree で実施 |
| ソース整合 | `npm run doctor`: `source_check_passes (source_matches)`。これは次回起動のソース検査であり、実起動成功とは別 |
| 回帰試験 | `npm test`: 900件、898成功、失敗0、スキップ1、TODO1。最後の HTML 配置変更後は該当7件を再実行して全成功 |
| Windows x64 | NSIS Setup `.exe` のローカル生成に成功。111,235,139 bytes、SHA-256 `7E1D84338DD433AF40F3B00A9FAFEA9C3010963F86E8D81D4F34AA86AFC666C1` |
| 署名 | Setup とアプリ本体とも Windows `Get-AuthenticodeSignature` は `NotSigned`。ビルドログ中の `signing with signtool.exe` は署名の証拠にならない |
| 依存監査 | `npm audit --omit=dev`: high 3、moderate 1。high は `follow-redirects`、`js-yaml`、`markdown-it`。固定依存の更新と回帰試験が必要 |

生成物は `.runtime/dist/` の Git 管理外にあり、この記録の SHA-256 は現地のローカル候補だけを指します。元の常用 runtime のファイルは保持しています。独立 worktree の再構築後、次回起動のソース整合は通過しました。インストール後の起動、クラッシュ後のアイコン再起動、ログイン時起動はまだ試験していません。

## 公開までの残件

1. Windows x64／ARM64 の署名・新規インストール・ショートカット起動・異常終了後の再起動・上書き更新・アンインストールを実機で確認する。署名証明書の所有者が未定。即時の無人再起動は別ゲートで、現段階の復旧経路は OS のアイコンからの手動起動。
2. macOS runner で署名・公証・staple した DMG を作り、x64／arm64 実機で Applications、Spotlight、ログイン時起動と Gatekeeper を確認する。Mac 実機と Developer ID／公証資格情報が未準備。
3. Chrome Web Store 発行者と Private 先行試験を用意し、審査後に実際のストア URL をアプリとサイトへ設定する。現状の拡張導入は開発用 unpacked のまま。
4. Google OAuth の不特定多数への公開条件と `gmail.readonly` の審査または例外適用を確定する。個人所有 Cloud プロジェクトは公開審査の代替ではない。利用者ごとの実効枠・請求状態は本人の Console で確認する。Workspace は管理者制限も確認する。
5. high 3件を含む本番依存の監査結果を解消・再評価する。署名済み成果物、Chrome 拡張、OAuth 公開判定、AGPL ソース・帰属、プライバシー説明、SHA-256 をそろえてから `kaduiro.com` に掲載する。サイトの公開担当とアクセス方法は未確認。

ローカルの未署名 Setup `.exe` を配布可能な正式版と表示しない。macOS の DMG、Web Store 公開物、サイトのダウンロードは現時点で存在しない。
