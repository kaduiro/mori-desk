# 起動復旧と常用・計測開発の分離

2026-10-31。`source_mismatch` の復旧と再発防止を実装した。常用側はこのリポジトリ直下、計測専用コピーは `.development/` 以下に置く。

## 実施したこと

- 通常runtimeを `node scripts/setup.js --reuse-dependencies` で正規再構築・差し替え。ソース／overlay／生成build情報の一致を確認。
- 新しい `scripts/prepare-development.js` は、未コミットの計測開発にも使える独立したソースコピーを作る。runtimeと固定upstreamキャッシュも通常ファイルとして複製し、projectRootの所有情報をコピー先に結び直す。常用の保存データ・実機採取JSON・ログ・OS起動登録は複製しない。
- 新規コピーは常に別UUIDの場所へ作り、既存コピーの編集を上書きしない。コピー中のソース変更や不一致を拒否し、未完了の場所はready=falseで保持する。成功時だけ `.development/latest.json` を切り替える。
- 計測キットの準備は、所有情報と位置を確認できる開発コピーだけで実行できる。開発コピーから通常Moriを起動しようとすると `development_workspace` で拒否し、常用プロフィールを開かない。
- doctor／setup／計測準備の表示に、ファイル保持とは別の「次回起動のソース検査」を追加。`source_check_passes` は実プロセスの起動成功やWindowsログイン成功の証拠ではない。
- 起動エラーを、ソース更新未反映／構築済みファイル不一致／整合性確認不能に分け、件数・build IDの短縮表示と `check-windows.bat` を案内する。

当時の実機では常用 runtime の build ID を照合し、`.development/workspace-<UUID>` に開発コピーを作成した。個人端末の絶対パスと build ID は公開文書から省いた。

これはGit worktreeではなく、未コミットのoverlayも含む独立コピー。公開・commitへ自動反映しない。必要な変更を常用側へ取り込むときは、差分確認・正規再構築・検証を行う。常用側のソースを直接編集すれば引き続き起動guardは不一致を拒否する。

## これからの使い方

通常Moriは従来どおりリポジトリ直下の `start-windows.bat`。計測ソースの編集と計測ツールの実行は `.development/latest.json` が指す作業場所へ移動して行う。

新しい開発コピーを作る場合は、常用側を再構築して一致を確認してから、常用側で以下を実行する。

```text
node scripts/prepare-development.js
```

計測実装を含む後続ブランチでは、開発コピーの中で初回の計測キットを以下で作成する。その後の同キット更新は `--refresh-smoke` を使う。この起動分離ブランチ単体には計測キットのスクリプトを含めない。

```text
node scripts/prepare-native-measurement.js --smoke
```

開発コピーのソース変更後に計測キットを再構築することと、開発コピー自身の通常runtimeを再構築することは別。表示されたソース整合状態を確認する。計測用Chrome拡張の読み込み先は、そのコピーが生成したkitの指示に従う。今回Chrome拡張の管理画面は操作していない。

## 確認結果

以下は2026-10-31の混合作業ツリーにおける履歴。分離した起動ブランチでは、固定上流から runtime を再構築し、`npm test` は437件中435件成功・失敗0件・skip1件・todo1件で確認した。

- Node24.21.0／Electron41.10.4、正規再構築成功。
- browser／Mori／source／startup等の全854 tests: 852 pass／0 fail／0 cancelled／1 skip／1 TODO、exit0。追加7件の個別assertも実行完了。skipはWindowsでcase違いの別directoryを作れない条件、TODOは合成検証で実provider recoveryを証明できない項目。
- 開発コピーで固定upstreamから再構築し、実Windowsの計測専用collector smokeはready。処理後も常用側と開発runtimeのソース検査はともに通過。
- 開発コピーの通常起動拒否を実際のguard呼出でも確認。常用ソースの整合性検証は緩和していない。
- 実Windowsの通常bootstrapをログイン引数で起動した後、Moriの実ウィンドウ・描画されたキャラクター・保存履歴を表示するHUDをcomputer-useで確認した。
- 手動bootstrapとログイン引数の再入場はexit0。既存インスタンスへの再入場であり、別の新規本体起動を証明しない。
- Mori固有の既存HKCUログイン起動登録を読み取り、常用runtimeのElectron／常用bootstrap／ログイン引数の参照を確認。登録を書き換えていない。これはOS側の有効状態や実ログイン後の起動を証明するものではない。
- 最初のログイン引数起動はbootstrapのexit0後も子が標準出力pipeを保持したため、確認harnessにETIMEDOUTが付いた。後続の実画面で本体起動を確認し、再入場のharnessはファイルdescriptorを使いtimeoutなしで完了。初回harness全体を無条件成功として扱っていない。

追補：利用者が実PCを再起動し、ログイン後の自動起動について「再起動後、正常に起動した」と回答した。今回の `source_mismatch` による起動失敗は、実再起動後の利用者確認まで完了。agentによる再起動後の画面・プロセス観測とは区別する。

Windowsのログアウト／ログインだけの別試験、Chrome監視の復帰、ChatGPT／Claudeの正式性能受入は未確認。PC再起動は利用者が実施し、こちらでは自動実行していない。保存データの初期化やOSの自動起動登録変更も行っていない。

## 証拠

以下の生レポートは個人環境でのローカル証跡であり、このブランチには同梱しない。

- `reports/startup-repair-build-20261031.txt`
- `reports/startup-repair-regression-20261031.txt`
- `reports/startup-repair-development-20261031.txt`
- `reports/startup-repair-development-smoke-20261031.txt`
- `reports/startup-repair-doctor-20261031.json`
- `reports/startup-repair-manual-mode-20261031.json`
- `reports/startup-repair-login-reentry-20261031.json`
- `reports/startup-repair-summary-20261031.json`
