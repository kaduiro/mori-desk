# 観測復旧とセッション識別の修正・独立検証結果

対象日: 2026-10-21 UTC

対象: Mori Desk `0.1.3-preview.1` / 拡張機能 `0.1.7` 修正候補

比較元: `3b1d39d178896d07ae36941518049f0bbef22c85`（製品ソースは拡張 `0.1.6`）

計画: [修正案と独立受入テスト計画](recovery-fix-test-plan-ja.md)

## 結論

**修正コードと独立試験を追加した。ただし、利用可能な完成版としては不合格であり、マージ・限定試用・社員配布は保留する。**

起動時のタブ照会障害を保存障害と誤認する問題と、再接続時に編集中の履歴カードが隠れる問題を修正した。会話取り違え対策については、登録・有効期限・停止時の受理制御・帰属確認を通過した観測だけを受け付ける基盤を実装した。

**実ChatGPT / Claudeの表示本文と現在の会話を結び付ける検証済みの判定は、まだ実装できていない。** そのため、この候補の本番コードは `binding_unconfirmed` を維持し、新しいページ観測を保留する。URL、履歴リンク、DOMの置換、一定時間の経過だけで承認する迂回処理はない。通常利用向けの更新として案内してはいけない。再接続やF5でこの制約は解消しない。

安全な保留と、有用な監視の復旧は別々に判定した。隔離した実Chromeの試験でも、入力・未読の保持は通過した一方、新しい観測の自動復旧は45秒の期限を超え、120秒まで受信できず `FAIL-no-recovery` となった。実サービスの有用な復旧を確認するI-B8は `UNKNOWN` のままである。

## 1. 変更内容

| 領域 | 実装した動作 | 残る条件 |
|---|---|---|
| A: 初期化とタブ照会 | storageの必須初期化と、タブ一覧・alarm・ページ監視復旧を分離。照会のthrow/reject/timeoutを専用カテゴリにし、保存と接続を維持して再試行 | 利用者のPCで失効が繰り返される契機そのものは未特定 |
| A: 閉じたタブの判定 | URLで絞らない物理タブID一覧を用い、照会開始時の行・順序・会話・設定世代を照合。古い一覧で新しい行を閉じない。自然alarmでも再照合 | 実Chromeのsleep/discard等の業務受入は別途必要 |
| B: 受理と復旧 | workerごとの登録許可、文書・ページ・会話・binding epoch照合、期限付き復旧ticket、installer定義と起動の分離を追加 | 実providerの帰属確認が未実装。現在は観測保留 |
| B: 停止・解除 | 要求受信時に新規受理を止め、先行する保存を決着させてから共通キューで設定・資格情報を保存し応答 | 実PCでの操作を含む通し試験は未実施 |
| B: 継続と通知 | 実際に観測を休止した時点で生成の継続判定を切り、再登録だけで旧生成を終了通知に変換しない。観測が続いたworkerだけの再登録は同じ生成を保つ | 合成の確認済みbindingを使ったプロトコル試験で検証。実providerの根拠にはしない |
| B: タブ移動と確認 | bootstrapとfocus成功を分離。最終focus返信後にも現在のタブ・会話を確認し、返信中に切り替わった会話の未読を消さない | Windows/macOSの実ウィンドウ操作は未確認 |
| C: 履歴カードの編集 | 論理上の件数ではなく実際のカード配置後に親領域の表示を決める。入力要素・フォーカス・変換内容・選択位置を保ち、編集終了後に移動 | Windows/macOSの実IME操作は未確認 |
| 診断と文書 | 保存障害・照会障害・帰属未確認を区別。未実装の帰属確認をF5で直る問題として案内しない。旧smokeの「自動復旧」表現も訂正 | 本体との接続成功だけをページ監視成功として扱わない |

[worker](../overlay/extensions/browser-bridge/service-worker.js)、[復旧処理](../overlay/extensions/browser-bridge/observer-recovery.js)、[content observer](../overlay/extensions/browser-bridge/content-script.js)、[帰属確認の保留処理](../overlay/extensions/browser-bridge/conversation-binding.js)、[表示処理](../overlay/src/mori-browser-renderer.js)が主な変更箇所である。

HMAC相互認証、Origin/Host検証、永続化後のACK、取得開始時の未読集合だけを対象にする確認処理、160 UTF-16単位のメタデータ制限を維持した。復旧で本文全体・下書き・AI回答・Cookie・鍵を読む処理は追加していない。診断は固定カテゴリと件数だけである。

## 2. 独立性をどう確保したか

実装担当と独立受入担当・独立ソースレビュー担当を分けた。独立の2担当は、実装側の既存モックや期待値を読む前に、自分の受入条件を固定した。共有したのは業務要件と、ドライバーが接続する登録APIの契約である。

### 独立受入担当

物理タブ、会話A/B/C、送信済み依頼、非公開の下書き、通知R1/R2を外部のシナリオ台帳で定義した。製品のreducer、メタデータ抽出、復旧結果から期待値を作っていない。Chrome API・時計・DOMのハーネスも既存のテストヘルパーを流用せず作成した。

固定台帳は [recovery-independent-ledger-v1.json](../overlay/test/fixtures/recovery-independent-ledger-v1.json)。SHA-256は `00e4efc143ee2bda402a5e50b6669baadba33ab66eac31bc2e88fb11df2e90b5`。最終試験でもこの値を照合している。

同じ試験を修正前後に実行した結果:

| 対象 | 成功 | 失敗 | UNKNOWNを示すTODO | 取消・skip |
|---|---:|---:|---:|---:|
| 比較元 `3b1d39d` | 14 | **12** | 1 | 0 |
| 修正版 | **26** | **0** | **1** | 0 |

合計27ケースのうち、I-B8は未実施の成功扱いにせず、明示的なTODOとした。Nodeの終了コード0は、業務受入の合格を意味しない。

タイムアウト前後の1499/1500/1501/1700/5000ms、実際に失敗するlocal/sessionの読み書き、遅延したタブ一覧、URL B / 中央DOM Aの再注入、古いDOMの複製、focus/health等からの迂回、pause/resume、実server/storeモジュールによるR1/R2の厳密な保持集合を検証した。

正常復帰のプロトコル試験では「帰属を確認済みのobserver」を明示的な境界のテストダブルとして使う。これは登録・送信の経路を検証するためのもので、実DOMの属性を捏造してprovider互換性を証明するものではない。実際の本番bindingを使う敵対的DOM試験と、実providerの未達ゲートを別に残した。

[統合結果とソースハッシュ](review-evidence/recovery-017/acceptance-results.json)、[修正前TAP](review-evidence/recovery-017/baseline-suite.tap)、[修正後TAP](review-evidence/recovery-017/corrected-suite.tap)に個別の結果を記録した。

### 故障を入れた試験で検出力を確認

隔離したソースコピーに1種類ずつ故障を入れ、同じケースの無変更版が通り、故障版が狙ったassertionで落ちることを確認した。起動時の構文エラーやテストプロセスの異常終了を「検出できた」と数えていない。

| 故意の変更 | 検出した要求違反 |
|---|---|
| タブ照会失敗を保存失敗へ戻す | 接続が無効化され、自動復帰しない |
| 保存失敗を握り潰す | 必須保存が失敗しても初期化を成功扱いする |
| 自然alarmだけ無効にする | 45秒以内に新しい報告が届かない。診断後には届くので、手動経路だけ動く状態を区別できる |
| 帰属を無条件で承認する | Aの依頼と生成をBへ記録する |
| 100ms経過だけで帰属を承認する | 古いDOMが残るBへAの情報を記録する |
| workerのfocus帰属gateを外す | 現在のobserverでも帰属を失った状態を成功扱いする |
| focus後に全未読を確認済みにする | クリック後に追加されたR2まで消える |

**7種類すべてで、無変更版PASS → 故障版の対象assertion FAILを確認。** 自動alarmを消した版は、自動窓では新報告0件、判定後の診断で受付1件・新報告2件となり、「診断が復旧を助けた」状態を独立して識別できた。

[故障注入結果](review-evidence/recovery-017/mutation-results.json)と[再実行スクリプト](../overlay/test/fixtures/recovery-independent-mutations.js)を保存した。これは選んだ7種類に対する検出力であり、未知の故障すべてへの保証ではない。

### 独立ソースレビューで追加発見した問題

| 指摘 | 修正・同一条件での再検証 |
|---|---|
| 複数タブを閉鎖記録中、最初の保存待ちにpauseが来ても次の行を処理できる | 各行のcommit前にも世代・停止状態を確認。要求受信時の即時受理停止と共通キューを確認 |
| 観測を止めた期間があるのに、再登録で旧running tokenを再開し終了通知を作れる | `breakSamplingContinuity`で生成とページ識別を切り替える。不変の独立oracleで、修正前に誤終端1件、修正後0件。観測が続いたworker再登録は正しい終端1件を維持 |
| 最終focus成功返信が配送中にA→Bへ切り替わると、旧Aの成功を返せる | 返信後に現在tab/routeを再取得し最終照合。不変の独立oracleでFAIL→PASS |

さらに実装担当が、timeout理由の診断待ち中に旧ticketが生きる期間と、pause中に閉じたタブ・初期照会失敗時の既不在タブを自然alarmで整理できない経路を検出し、修正前の反例と修正後の通過を確認した。

独立ソースレビューは、直接試験26シナリオと検出力確認3シナリオの計29シナリオで通過した。Cの祖先表示・IMEイベント・非同期保存、contentの4条件、workerの18条件と検出力確認2条件、recoveryの遅延installerとticket失効を、別のハーネスと操作順で確認した。実装テストと同じモックによる二重承認として扱っていない。[独立レビューの判定と未達範囲](review-evidence/independent-review.md)、[再現手順](review-evidence/README.md)に詳細を残した。

## 3. 実環境で確認したことと限界

### 実Chrome + 合成ページ

新規の一時プロファイルを使い、ChatGPT向けリクエストは固定HTMLへ置き換え、それ以外のページHTTP(S)通信を止めた。実アカウントと既存のChromeプロファイルは使っていない。Moriの実bridgeとHMACを使い、OS暗号化部分のみ合成safeStorageで置き換えた。

拡張0.1.6で未読R1を作り、次の生成と未送信入力を保持した状態で0.1.7へ更新した。更新操作を最後に、45秒の判定期限・120秒の観測終了まで、ドライバーはdesktop側の変更通知を記録するだけとした。health、retry、status、再ペアリング、監視切替、F5、対象タブの前面化、ページDOM読取りは行っていない。製品自身のalarm・再試行は許可した。

| 確認 | 結果 |
|---|---|
| ページのロード回数・同一文書 | 保持。F5なし |
| 未送信入力・既存未読 | 保持 |
| 帰属未確認の観測を受理するか | 受付0。`binding_unconfirmed` 1件、復旧0件 |
| 45秒以内の有用な自動復旧 | **不合格** |
| 120秒までの新しい有用な報告 | 0件。`FAIL-no-recovery` |
| 拡張を再度reload後の保留・入力・未読 | 保持 |
| Service Workerの自然停止からの復帰 | **未実施**。検査接続のある拡張reload試験を自然停止の証明にしない |

試験コードそのものにも独立レビューを行い、「running/freshだけを見れば、一瞬受理されたidleのメタデータを見逃す」という指摘を反映した。desktopの変更通知で新runの観測を状態に関係なく記録し、有用なrunningへの復帰とは別に判定する。未読は件数だけでなく、対象行・通知sequence・turn・結果の集合を比較し、一時的な置換後の復元も失敗として記録する。45秒の期限は変更通知の到着時刻で測る。古い行、一瞬のidle受理、fresh時刻が0のunsupportedメタデータ受理、45000/45001ms、同数の通知置換という5つの試験も追加した。[試験コードの独立再レビュー](review-evidence/recovery-017/smoke-independent-review.md)では、この固定fixtureの検出範囲に重大な未解決指摘がないことを確認している。

任意実行の[Chrome試験](../overlay/test/browser-extension-chrome-smoke.js)は、安全性のみ通過し業務受入が不合格なら終了コード **2** を返す。成功コードへ丸めない。過去の0.1.6試験はhealthを繰り返しており、自動処理だけで復旧した証拠として使えないため、その記述も訂正した。

### レンダラー

Cの実装担当は、更新済みHTML/CSS/rendererをLinux headless Electronで開き、編集中の唯一の履歴行が再接続した後、保存ボタンへ実マウス入力を送った。正しい行へ保存1回、保存完了表示、現行一覧への移動を確認し、blur中の移動でクリックが失われる問題はその条件では再現しなかった。

これはWindows/macOSの実IME候補操作の証拠ではない。合成compositionイベント、Linux Electron、Windows CIも、実際の利用者のChrome・IME・sleepの通し確認とは区別する。

## 4. 最終検証記録

最終ソースを固定upstream・patch・overlayから再構築した。Node 24.19.0 / Electron 41.10.4、Linuxで実行している。

| 検証 | 結果 | 証拠・範囲 |
|---|---|---|
| overlayと生成runtimeの一致 | **70 / 70ファイル一致** | [ファイル別SHA-256](review-evidence/recovery-017/runtime-reconstruction.json) |
| 最終runtimeの `npm test` | **304件中303 PASS、FAIL 0、TODO 1、skip 0** | [全実行ログ](review-evidence/recovery-017/regression-final.log)。TODOは未実装の実provider受入I-B8 |
| 独立受入 | **26 PASS、TODO 1** | 上記304件に含まれる。別件数として重複加算しない |
| 独立ソースレビュー | **29シナリオ PASS** | 別ハーネスでの直接26・検出力3。業務全体の合格を意味しない |
| 故障注入 | **7 / 7種類を対象assertionで検出** | 上記304件とは別の感度検証 |
| 最終runtimeの実Chrome | **安全性PASS / 業務FAIL-no-recovery / 終了コード2** | [最終結果JSON](review-evidence/recovery-017/chrome-recovery-results.json)、[診断画面](review-evidence/recovery-017/chrome-recovery-options.png)。Chrome 156.0.8078.47、Linux headless、合成ページ |
| Windows CI | **未実施・GitHub反映待ち** | 公開リポジトリへの送信が自動承認レビューで拒否されたため、このソースでのCIは起動していない。旧版CIを流用しない |

通常の回帰はリポジトリの `npm run setup`、`npm test` で再現できる。独立ソースレビューは前掲の再現手順に従う。任意Chrome試験は、Node 24.x、Playwright、Chrome for Testing、基準コミットの拡張ディレクトリを外部入力とし、生成runtimeの `test/browser-extension-chrome-smoke.js --chrome <実行ファイル> --playwright <モジュール> --baseline-extension <0.1.6の拡張> --output-dir <新規結果ディレクトリ>` を実行する。終了コード2は業務受入の不合格である。

主要な検証対象ソースのSHA-256:

| ソース | SHA-256 |
|---|---|
| service-worker.js | `187b45a8e2b1988984913e854bfb76b9afca39c6d3e59dd948f2afce7f38a04d` |
| observer-recovery.js | `bd81dac7cd27afc1758c88b88b4ea0c063b82d08bde6ea6501a3d100808981bc` |
| content-script.js | `bbca446fa121a577e1fd00e6b0e66fed9eeb7d4a08b7923526a64c99996620c1` |
| mori-browser-renderer.js | `b8d4ca0d91ae62b5c97bf9c86bf47966c4f3106c7b5590d995fb821c1fc37694` |

## 5. まだ満たしていない条件

1. 実ChatGPT / Claudeで、現在の会話に属する中央表示を確かめる根拠を調べ、provider別に実装する。推測の属性や一定待機を根拠にしない。
2. その根拠を使って、診断を押さない復旧、タイトル・依頼・状態・通知・正しいタブへの移動を通したI-B8を実施する。永久unknownは合格にしない。
3. Windows/macOSで実IME、native focus、サイト許可、タブ破棄・凍結、sleep復帰、自然worker停止を確認する。
4. 限定試用2時間・sleep3回、その後の社員向け1業務日と翌回起動を、実際のOS構成で確認する。

この作業環境では、接続ブラウザのAPIが「元のブラウザコンテキストが必要」と返し、実サービスの画面を取得できなかった。別ブラウザへ無断で切り替えたり、未確認の画面から帰属属性を捏造したりはしていない。実画面の確認には、接続済み拡張のあるブラウザからこの会話へアクセスできる環境が必要である。

同一タブ内で現在表示していない複数会話を同時に監視する機能も、今回追加していない。履歴として行を残すことは、非表示の会話の生成を継続観測することとは異なる。旧版で保存された通知の正当性を遡って証明・自動修正することもできないため、正当な未読を一括削除する処理は加えていない。

## 6. 提出・公開の状態

修正・試験・独立レビューの証拠はローカルの作業ブランチに保存した。既存の [Draft PR #5](https://github.com/kaduiro/mori-desk/pull/5) への反映を試みたが、GitHubのtree作成操作が自動承認レビューで拒否された。理由は、**公開リポジトリ `kaduiro/mori-desk` へのソース・試験・検証記録の公開について、利用者の明示的な許可を確認できないため**である。

拒否後、別経路でのpushやアップロードは行っていない。今回の変更についてリモートbranchの更新・PR本文の更新・CI起動・マージ・リリースは行っていない。送信予定の本文は [PR更新案](recovery-pr-draft-ja.md) として保存した。

公開が許可された場合の次の操作は、既存Draftブランチへ今回の差分と証拠を反映し、PR本文を更新し、そのソースに対するWindows CIを確認すること。これは配布やマージの承認ではなく、実providerの帰属確認と業務受入が未達という判断は変わらない。
