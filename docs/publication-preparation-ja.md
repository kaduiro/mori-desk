# 公開候補を固定 blob から準備する

`scripts/prepare-publication.mjs` は、公開するファイルをレビューできるローカルパケットへまとめる CLI です。作業ツリーをコピーせず、明示したコミットにある Git blob を読みます。ネットワーク通信、元リポジトリへの書き込み、コミット作成、push、PR 更新、CI 起動は行いません。パケットの作成は公開許可を意味しません。

Node 24.18 以上の 24.x と Git を用い、`--repo` には実際のリポジトリの top-level を指定します。元リポジトリと Git メタデータの外にある既存ディレクトリを出力先の親として指定します。linked worktree の共有 Git ディレクトリも出力不可です。出力先自体は未作成でなければなりません。

```sh
node scripts/prepare-publication.mjs \
  --repo /absolute/path/to/mori-desk \
  --spec /absolute/path/to/reviewed-publication-spec.json \
  --remote-observation /absolute/path/to/read-only-github-observation.json \
  --output /absolute/path/outside-repository/new-packet

node --test test/prepare-publication.test.js
```

## 入力

spec の `files` は、公開先の `baseCommit` から変えるファイルだけを列挙する allowlist です。フォルダーやコミット全体を自動採用する機能はありません。各 `sourceCommit` は完全な 40 桁の commit SHA で固定し、そのパスの Git blob SHA、mode、サイズ、SHA-256 を事前の確認結果と照合します。`HEAD` やブランチ名は使えません。ローカルの Git replace ref によるオブジェクト置換も使いません。

`--remote-observation` には、spec と独立に取得した GitHub の読み取り観測 JSON を渡します。`observedAtJst`、`repository`（`fullName`、`visibility`、`archived`）、`pullRequest`（`number`、`headRepository`、`headBranch`、`headSha`、`baseBranch`、`state`、`draft`、`merged`）を保存してください。対象は public / 非 archived、main を base にした open / 未 merged の Draft PR #5 です。CLI は添付観測の head と `baseCommit` が一致することを要求します。これにより、spec だけで作業側 HEAD を公開先の親へ誤って採用することを防ぎます。

この照合は、観測 JSON の真正性や最新性を証明しません。`manifest.remoteFreshness` は常に `pending` です。観測の取得元・取得時刻をレビューし、送信直前に実際の remote head を再取得して期待 SHA と一致することを確認する必要があります。

| フィールド | 指定する内容 |
| --- | --- |
| `schemaVersion` | `1` |
| `destination` | `repository: "kaduiro/mori-desk"`、`visibility: "public"`、`branch: "codex/browser-conversation-labels"`、`pullRequest: 5`。この復旧タスクの宛先に限定 |
| `authorization` | 常に `"not-recorded"`。入力ファイルで承認済みと宣言することはできない |
| `baseCommit` | 読み取り確認した公開先ブランチの完全な commit SHA |
| `expectedTargetTreeSha` | 任意。別の手段で確認した合成後の tree SHA があれば必須照合に使う |
| `prBodyPath` | `files` に含まれる UTF-8 文書のパス。PR 本文も同じ固定 blob から採る |
| `productReadiness` | その候補の検証結果、未達、配置可否を明記した文字列 |
| `excludedPaths` | 追加で除外するファイルまたはディレクトリ。既定除外は解除できない |
| `files` | 下記の変更レコードの配列 |

追加・更新レコードには `path`、`operation`（`add` または `modify`）、`sourceCommit`、`blobSha`、`mode`（`100644` または `100755`）、`bytes`、`sha256` を指定します。削除レコードには `path`、`operation: "delete"`、公開先で確認した `beforeBlobSha` を指定します。追加・更新の区別、変更前の blob、mode、サイズ、ハッシュが一致しない場合は出力しません。

既定除外は、承認分析、並行計画、内部実行記録とそれぞれの証拠ディレクトリです。これらが変更一覧だけでなく合成後の tree に残る場合も拒否します。既存の公開用文書に後から内部分析を追記した場合は、そのパスを単に除外するだけでは足りません。公開を検討した時点の古い blob を個別に選びます。

## 出力

| ファイル | 用途 |
| --- | --- |
| `payload/` | 明示した追加・更新ファイルの完全な bytes。バイナリを文字列へ変換しない |
| `manifest.json` | 宛先、base / target tree、変更種別、mode、Git blob SHA、SHA-256、サイズ、各ファイルの出典 commit、未実施事項 |
| `publication-spec.json` | 入力の保存 |
| `remote-observation.json` | 添付された読み取り観測の保存。manifest に取得時刻と SHA-256 を記録 |
| `changes.patch` | 変更前後の実ファイルから Git で生成した binary 対応差分。削除も含む |
| `pr-body.md` | 指定した固定 blob と同一の PR 本文 |
| `PUBLICATION-SCOPE.md` | 公開範囲の確認案、現在の製品判定、送信前後の確認境界 |
| `SHA256SUMS` | パケット内容のチェックサム一覧 |

送信候補は `manifest.outboundPaths` の payload と指定した PR 本文です。削除は `manifest.files` のレコードに従います。manifest、spec、差分などの点検用ファイルをまとめて公開先へコピーしません。ファイル一覧が正確であることと、内容が公開可能であることは別の確認です。本文や画像の公開内容レビューは人が行う必要があります。

## 後続修正を混ぜるとき

旧パケットとその spec は保持し、新しい spec / 出力先を作ります。公開用の既存文書・証拠は以前の `sourceCommit` のまま保持し、必要な製品修正、試験、公開用の説明だけを新しい固定コミットの blob へ置き換えます。新規パスは個別に追加し、mode、サイズ、ハッシュも更新します。`expectedTargetTreeSha` は旧値を流用せず、新しい合成 tree と照合します。旧コミットの検証成功を、新しい候補の検証成功として記載しません。

元コミットには内部分析が同居していても、選択していないファイルや祖先はパケットに入りません。将来の送信では合成 tree から、`baseCommit` **だけ**を親とする新しい公開コミットを作る必要があります。元の source commit やその履歴を push / merge すると、この境界を保てません。

公開範囲の許可を確認した後も、送信直前の remote head、実際の宛先、送信後の tree と commit、CI の対象 SHA を別途確認します。この CLI は公開可否を判定せず、以前の送信拒否を別経路で回避する機能も持ちません。

## 検証の範囲

専用テストは一時 Git リポジトリを使い、バイナリ・非 UTF-8 テキスト・削除・実行 mode を含むパッチを実際に適用し、Git の `write-tree` が返した tree と一致することを確認します。作業ツリーを汚した状態、内部文書を持つ後続コミットからの部分採用、Git replace ref、添付観測との base 不一致、ハッシュや mode の不一致、承認済みの自己申告、既存出力への上書きも検査します。これは公開パケットの検証であり、Mori Desk の接続復旧、実サービス DOM、実 Windows、公開 CI の合格証明ではありません。

対応パスは英数字、`_`、`-`、`.`、`/` に限定し、親参照や生成物ディレクトリなどは拒否します。変更対象の symlink / submodule は未対応です。実行 mode の保持には対応するファイルシステムが必要です。欠落した Git オブジェクトを取得する fetch は行わないため、必要な固定コミットと blob がローカルに存在する状態で実行してください。
