# 接続競合・版照合の検証証拠

2026-10-21 / Linux / Node 24.19.0。実装の説明は [追加修正記録](../../recovery-version-fix-ja.md) を参照。

| 記録 | 読み方 |
|---|---|
| `source-before.tap` / `source-regression.tap` | 旧版の起動前検査に同じ条件を適用した結果と、修正後のルート回帰試験。旧版の FAIL は期待した拒否がないという assertion |
| `transport-async-before.tap` / `transport-async-after.tap` | 初回に見つけた非同期保存・停止・タイムアウト・置換の競合 |
| `transport-boundary-before.tap` / `transport-boundary-after.tap` | 独立レビューが追加した callback 再入停止・旧 pair finally の反例 |
| `transport-regression.tap` | 実装側の transport 13 件。ローカル loopback と本物の backend を使う |
| `independent-criteria*.md` | 差分・既存 fixture を読む前に固定した基準。原文を保持 |
| `independent-transport*.json` / `independent-source-results.json` | 別担当の独自 driver の結果。socket/timer/Git/起動の代替を使った範囲は報告書に明記 |
| `independent-*-mutant-results.json` | 起動拒否・byte 不一致検知を壊した隔離故障版。意図した assertion が検出することを確認 |
| `independent-review-ja.md` | 独立性、発見した反例、修正後判定、検証限界、実 provider 証拠の不足 |
| `doctor-filetype-before.json` / `doctor-filetype-after.json` | 初期 doctor の実 FIFO による停止と修正後の実 CLI。after は fs の代替を挟まず通常の CLI を実行 |
| `disk-doctor-after.json` | 再構築した作業環境のディスク照合。記録時は基準 HEAD に未コミットの修正があるため trackedChanges=true。実行中 Chrome は未確認 |
| `setup.log` | 固定ソースからの実再構築、依存導入、Electron 導入検証。Electron GUI の受入証明ではない |
| `full-regression.tap` / `validation-summary.json` | 最終の assertion 単位の全体集計と、その検査範囲 |
| `source-manifest.json` | 検証した変更ファイルと overlay の SHA-256。コミット番号の代わりに異なる byte 列を同一としないための照合記録 |

## 独立 driver の保存方針

`independent-transport.js` と `independent-source.js` は、実際に実行した driver の原文を保存したもの。
実装側の回帰へ取り込んで同じ fixture に作り替えていない。原文には実行時の `/tmp` と checkout のパスがある。
transport driver は第1引数で検査する transport ソースを指定できるが、補助 module の root は原文の `repo` を使う。
source driver は `MORI_INDEPENDENT_SOURCE_ROOT` で checkout を指定する。
別環境へ移す場合はこの設定と出力先だけを合わせ、期待値・操作順を変えないこと。

source driver は実行前に、自分専用の `/tmp/mori-next-independent-fifos/fifo-1` から `fifo-5` を用意する。
fixture へ移して検査後に削除するため、故障版を再実行するときも新しい FIFO を用意する。
この Linux の特殊ファイル試験を Windows の実機試験として扱わない。

テスト内の会話 ID、暗号鍵、識別文字列、HTML 等は合成の fixture。
実利用者の会話本文、下書き、認証情報、画面はこの証拠に含まれない。

## 残る受入条件

本番 provider binding、実 ChatGPT / Claude、実 Windows / 日本語 IME、背景利用、自然 worker 停止、
45 秒以内の無介入復旧、長時間利用はこの記録では合格にしていない。
既存の `I-B8` 未達と `FAIL-no-recovery` は残る。別々の試験の件数を合算して、
一つの業務シナリオを実サービスで通した回数として数えない。
