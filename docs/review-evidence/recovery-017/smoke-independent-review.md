# Chrome smoke の独立再レビュー記録

## 結論と範囲

前回の `idle / fresh` 一時受理、および追加指摘した `unsupported`・`lastObservationAt = 0` の metadata 受理について、検査の見逃しが解消されたことをソースで確認した。現在の固定 fixture と受入条件について、重大な未解決指摘はない。

対象は `/workspace/scratch/71b181da6eca/mori-desk/overlay/test/browser-extension-chrome-smoke.js`。確認時の SHA-256 は `27c5203f40a9f23aa5d0c86dec2ea9b6f9522016ba7c1c183d484589d12de4e6`。

本レビューはソースの読み取りのみ。既存テストの期待値を正解として利用せず、製品・試験の追加実行、製品編集、commit は行っていない。担当者が報告した ledger テスト 5 件 PASS は、本レビューによる独立実行結果ではない。

## 指摘と修正確認

| 指摘した反例 | 最終コードの確認 |
|---|---|
| 未確認 fixture を一時的に `idle / fresh` として受理し、後の診断では unconfirmed に戻る。旧判定は `running` の有用回復だけを探すため安全 PASS になり得た。 | `bridge.onChange` から `createPassiveLedger.capture` が呼ばれ、安全側の `firstAcceptedObservationMs` は phase に依存せずラッチする。有用な `running / fresh` 回復とは別判定になった。 |
| 初回の `unsupported` 行に metadata が保存されても `lastObservationAt` は 0 のため、中間修正版のラッチ対象外になった。 | `newReports` は baseline にない run の全行を対象とし、`lastObservationAt` 条件を除去した。store の `connect` / `disconnect` は新規行を作らず、`ingest` が新規行を作ることも確認した。この一時受理は後で消えてもラッチが残る。 |

## 受動性と判定の分離

- ledger は desktop の変更通知を記録するだけで、extension / page へ要求を送らない。reload を開始操作とする窓の中に health、retry、status、page inspection、tab activation はなく、診断は判定確定後である。
- 45,000 ms の有用回復期限は callback の受信時刻で評価する。120,000 ms を超える callback は無視され、窓後に ledger を切り離すため診断が verdict を書き換えない。
- baseline の全 run を除外し、有用回復には current・running・fresh・baseline より新しい観測時刻を要求する。旧保存行を回復成功に数えない。
- 未読は件数に加えて行 ID、notice sequence、turn、outcome を比較し、途中の差異をラッチする。今回の固定 fixture は未読 1 件であり、この確認を複数未読 receipt 全件の検証に一般化しない。
- quarantine の安全確認と business acceptance は独立した結果である。安全 PASS でも有用回復がなければ `FAIL-no-recovery` / exit 2 となり、業務受入成功にはしない。

実 provider の会話 binding、自然な worker 停止、Windows IME、OS 暗号化の成立を本レビューは証明しない。合成 fixture の安全確認は、実サービスでの有用な復旧が未達であることを解消しない。
