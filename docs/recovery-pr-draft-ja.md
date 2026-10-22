## 課題と現在の判断

本体との接続が戻ってもページ監視が戻らず、会話切替中の古い表示を別の会話へ帰属させる場合がありました。
さらに、接続処理を止めても古い非同期処理が接続済み通知や定期通信を復活させる競合と、
ソース更新後も同じ版番号の古い本体を起動できる問題を確認しました。

**Draft を維持します。実 ChatGPT / Claude の会話所属確認は未実装で、拡張 0.1.7 は通常利用向けの更新ではありません。**
この候補は新しいページ観測を保留します。再接続や F5 で監視が有効になる版ではなく、
マージ・限定試用・社員配布は保留です。

## 変更

- 必須の保存初期化とタブ照会・復旧を分け、照会の失敗を保存障害と誤分類しません。遅延一覧による行の消去を防ぎ、欠落タブの照合を再試行します。
- worker の登録許可、世代、文書・会話照合、期限付き復旧 ticket を追加し、遅延注入や停止・解除後の旧応答から監視を再開しません。観測が途切れた期間の終了は推測しません。
- 最終 focus 返信後にも会話を照合し、配送中の会話切替で旧会話の未読を消しません。再接続で唯一の履歴編集行を隠さず、入力・選択・composition を保持します。
- 通信の async 継続と状態通知 callback の後に接続の所有権を再確認します。旧 pair の finally は現 pair の排他状態を解除しません。
- 起動前に pin / patch / overlay と構築時の記録、コピーされた overlay の byte 列を比較します。古い本体はデータを削除せず起動を拒否し、再構築を案内します。
- doctor.js / check-windows.bat でソース・本体・指定された拡張フォルダーを読取り比較します。実行中 Chrome は別の確認として残します。
- 拡張設定の冒頭に、この版のページ監視が未完成であることを表示します。1 タブの非表示の過去会話を同時観測する機能は追加していません。
- 固定 Git blob と別途取得した remote 観測から、ローカルの公開候補を準備する CLI を追加します。候補作成は公開許可や送信ではありません。

HMAC、Origin / Host、safeStorage fail-closed、永続化後 ACK、通知対象集合、
タイトル・送信済み依頼の抜粋それぞれ 160 UTF-16 単位までのローカル表示という境界を維持します。
本文全体、下書き、AI 回答、Cookie、実利用者の鍵は収集しません。

## 公開前のローカル検証

| 検証 | 結果と範囲 |
|---|---|
| Linux の全体回帰 | 328 tests / 327 PASS / 0 FAIL / 1 TODO。TODO は実 provider の帰属根拠を要する I-B8 |
| 全体回帰後の公開 CLI の最終修正 | 影響する専用 9 件を再実行し 9 PASS。上の 328 件に重複加算しない |
| 今回追加した製品の独立検証 | transport 12 / 12、起動前照合・doctor 33 / 33 PASS。実装側の既存 fixture と期待値を流用していない |
| 独立反例・検出力 | callback 内停止、旧 pair finally は同じ driver で FAIL→PASS。起動拒否無効化と byte 不一致無視の故障版を意図した assertion で検出 |
| 公開候補生成 | 実 Git で binary / 非 UTF-8 / 特殊なパス / 削除 / mode を含む patch を適用し、target tree と照合。内容・履歴・出力先の境界も独立レビュー |
| runtime 再構築 | overlay 70 / 70 ファイルが一致。拡張 18 ファイルのディスク照合も一致 |

callback 内停止と並列 pair は transport API の境界で再現したもので、通常 UI からの到達性は限定されます。
利用者の定期的な切断の原因を、この競合に確定したとは扱いません。

## 残る受入条件

実 provider の帰属根拠と正の通し動作、実 Chrome での無介入復旧、自然 worker 停止、
Windows / macOS の IME・native focus・sleep、限定試用 2 時間と復帰 3 回、勤務 1 日と翌回起動は未達です。
以前の固定合成 Chrome 試験の FAIL-no-recovery は解消した扱いにしません。
機械試験の成功やディスク上の版の一致を、業務全体の完成保証にしません。

## 公開後の Windows CI と追加修正

初回公開 `b228d003` の Windows 回帰は 328 件中 318 PASS / 9 FAIL / 1 TODO でした。
失敗したのは公開候補の準備試験で、通常のリポジトリも、正規化後のパス文字列が違うため
リポジトリの最上位ではないと拒否されました。ログには比較した文字列自体がないため、
大小文字・区切り・短縮パスのどれが差を生んだかは断定しません。

後続 `2aa128d` では、実ディレクトリの識別情報を使うことで正常な root と
Windows の別表記の正例が通過しました。一方で、linked worktree から共有 Git 管理領域内へ
出力できる欠陥を実 Windows で検出しました。結果は 330 件中 326 PASS / 2 FAIL / 1 SKIP / 1 TODO です。
2 FAIL はこの反例と親テスト、SKIP は当該ファイルシステムで作れない大小文字だけ異なる別実体の試験です。

さらに出力先の既存親から祖先をたどり、ソース・Git dir・common Git dir の実体と照合して
内部への出力を拒否する修正を加えます。同じ場所を指す別名を許可する正例と、別名でも
ソース内や管理領域内への出力を拒否する反例を、それぞれ確認します。

初回の失敗は [push run](https://github.com/kaduiro/mori-desk/actions/runs/39606044510) と
[PR run](https://github.com/kaduiro/mori-desk/actions/runs/39606054268) に保持します。
共有 Git 管理領域の反例は [後続 push run](https://github.com/kaduiro/mori-desk/actions/runs/39607556267) と
[後続 PR run](https://github.com/kaduiro/mori-desk/actions/runs/39607563013) に保持します。
修正版の CI 結果は、対象 commit・実 checkout・run ID を照合して PR 本文へ追記します。
Windows CI の成功は、実 Chrome / ChatGPT / Claude や利用者環境の受入完了を意味しません。

詳細: [追加修正・検証](https://github.com/kaduiro/mori-desk/blob/codex/browser-conversation-labels/docs/recovery-version-fix-ja.md) / [先行する修正と検証](https://github.com/kaduiro/mori-desk/blob/codex/browser-conversation-labels/docs/recovery-execution-ja.md)。
