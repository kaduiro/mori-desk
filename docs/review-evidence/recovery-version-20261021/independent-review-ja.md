# Mori Desk 次差分の独立受入レビュー

実施日: 2026-10-21 UTC。担当: `/root/implement_independent_acceptance`。
基準HEAD: 親から指定された`d3aef35`。この担当はGit操作を行っていない。

## 判定

**今回確認したtransport競合修正、起動前のsource/runtime照合、読取り専用disk doctorについて、限定した差分受入をPASSとする。未解消の重大指摘はない。**

独立driverでtransport 12件、起動前照合/doctor 33件、計45件がPASSした。transportで独立発見した2反例は、期待値を変えずにFAIL→PASSを確認した。起動チェックを無効化する故障版、拡張byteの不一致を無視する故障版も、正常版PASS→狙ったassertion FAILとして検出した。

これは実サービスでの監視・自動復旧の合格ではない。実ChatGPT/Claudeの帰属未確認、本番bindingの保留、I-B8未達、旧Chrome合成ページのFAIL-no-recovery、Windows/IME/背景復帰/継続利用の未実施は残る。新しい接続履歴の診断UIは未着手であり、実装済みに含めない。公開候補送信・remote/CI照合もこの担当の検証範囲外である。

## 1. 独立性

実装差分、既存mock/fixture/テスト期待値を読む前に、以下を固定した。

| 事前基準 | SHA-256 |
|---|---|
| `/tmp/mori-next-acceptance-criteria.md` | `73039fedd5f767a2c3b9eb0e8beb3068e81983c2a354a79a5644c71578561109` |
| `/tmp/mori-next-acceptance-criteria-addendum.md` | `3879ccaa0d1f952e23decbfa22ebc1f62cfdbe5bfacbfa29a28861f163b21fcc` |

原基準は最終検証時にもhashが一致している。最初に製品source/APIだけを読み、独立driverと元の期待値を作った。親の`runtime-source.test.js`と実装担当の`browser-extension-transport.test.js`は独立driverを作成・実行した後で査読した。既存テストのmock/期待値はコピーしていない。

transportは独立WebSocket代替、独立timer台帳、暗号演算の外部ラッチを使用した。peerのHMACはNodeの`crypto.createHmac`で、公開protocolのcontextを独立に構成した。製品の`canonical`/`hmac`はoracleに使っていない。`isReady`や内部generationを外部期待値にせず、socketへの送信、状態通知、onReady、heartbeat開始、後続socketの有無を確認した。

source/doctorは`/tmp`の独立した小さなディレクトリ群を使った。製品の`inputFingerprint()`は初期の整合したsetup markerを作るためだけに使用し、期待値は「外からどのpin/patch/fileを変更・追加・削除したか」で定めた。通常setupの再構築を実行した証拠ではない。実ファイルの読取りとhash比較を行い、fsの書込みAPIは拒否する境界を置いた。Git関連は要求されたread-only argvを捕捉した境界スタブであり、実Gitコマンドを実行していない。

## 2. 独立発見した反例と解消

| 指摘 | 修正前の独立観測 | 修正後 |
|---|---|---|
| T09: connectedの状態callback内で停止 | `onStatus(connected)`から`setEnabled(false)`後に、onReady 1回とheartbeat開始が発生した | callback直後に所有権を再確認し、Promiseのfulfilled確定も後ろへ移した。同じdriverでonReady 0、interval 0。停止時のPromiseも決着する |
| T02/T06: 旧pairのfinallyが新pairの排他を解除 | pair C1→pair C2→C1 finally→明示retryで、C2認証中に3本目のresume socketが作られた | pairごとのownerにより旧finallyを失効。同じdriverでsocket数2のまま。製品回帰には現owner終了後にresumeできる正の対照も追加された |

これらはTransport API単体で成立する反例である。現workerの`onStatus`は同期の状態代入であり、options操作は直列化されるため、通常UIからの直接到達性は限定される。今回の独立検証で見つけたAPI境界の欠陥として記録し、利用者PCで繰り返される元の切断原因と断定しない。

修正前transport結果: `/tmp/mori-next-independent-transport-before-results.json`（10 PASS / 2 FAIL）。
修正後transport結果: `/tmp/mori-next-independent-transport-results.json`（12 PASS / 0 FAIL）。
driverは両者で同一、SHA-256 `4a8b37248989d71c2984c3653d3cb415196f3d64f501035f74df8cdd00147954`。

## 3. 最終の独立検証

| 分野 | 結果 | 具体的な確認 |
|---|---|---|
| transport | 12 / 12 PASS | 正常HMACとACK、server/client proof待ち中のpause/置換、旧crypto reject、資格保存待ち中pause、旧close/error、旧focusの完了、停止後の明示再開、上記2反例 |
| 起動前照合/doctor | 33 / 33 PASS | pin/patch/overlay変更・追加・削除、欠落/破損stamp、実runtime byteの後変更、同semver別byte、未指定/欠落、製品identity、Git root帰属、読取り専用、実行中未確認 |
| 特殊ファイル | 上記33件に含む5件 PASS | 選択manifest、runtime package、lock、patchの実FIFOとmanifest→FIFO symlink。非通常ファイルにreadFileを試みる前に拒否し、specialReadsは0 |
| 継承コード/余分なファイルの範囲 | 明示した範囲でPASS | 継承runtime変更はNOT_CHECKED。選択拡張の余分なfileはexpected_source_files_onlyの対象外。全byte完全性を証明したと解釈しない |
| Windows BAT | 静的レビューのみ | `existing` Node選択、doctor実行、ERRORLEVEL保持、disk-onlyの説明。実Windows起動はNOT-RUN |

元のsource/doctor 23件に、別担当が発見した特殊ファイル、製品identity、親Git帰属の境界を10件追加した。既存23件の期待値は変更していない。FIFOの初回準備ではNode子プロセス起動が環境のEPERMで失敗したため、製品FAILに計上せず、Pythonの`os.mkfifo`で`/tmp`へ用意した実FIFOを使って再実行した。

環境はLinux、Node v24.19.0。実WebSocket/Chrome/Electron/Windows/IMEの証拠ではない。transportのpeer暗号演算は本物だが、socketとtimerは制御可能な代替である。ランチャーの呼出しは捕捉し、実Electronを起動していない。共有`.runtime`は変更していない。

## 4. 故障版の検出力

正常版と同じ独立driverを、`/tmp`の隔離コピーへ適用した。

| 故障版 | 結果 | 狙った検出 |
|---|---|---|
| requireRuntimeのsource照合拒否を無効化 | 25 PASS / 8 FAIL、終了コード1 | patch/overlay変更、stamp欠落・不正、runtime後変更を拒否しないため、期待した例外/拒否が欠けるassertionでFAIL |
| doctorでchanged byteをstatus判定から除く | 30 PASS / 3 FAIL、終了コード1 | 実runtime変更と同semver別byteの拡張をmatches_sourceとする誤判定、CLIの誤った成功exitを検出 |

両故障版とも構文エラー・起動クラッシュではなく、狙った要件違反を検出した。未変更の正常版は、同じ33ケースで再度全件PASSした。これらの故障版は製品ブランチに存在しない。

結果: `/tmp/mori-next-independent-launch-mutant-results.json`、`/tmp/mori-next-independent-version-mutant-results.json`。

## 5. sourceと回帰テストのレビュー

- `requireRuntime()`はpin/所有権/製品identityに加え、setup入力fingerprintとoverlay由来の実runtime byteを検査してから起動を許可する。拒否はruntimeや利用者データを削除しない。文書だけの変更で不要な再構築を求めない。
- doctorはChrome・本体プロセス・provider受入・自動復旧をNOT_CHECKEDとして維持する。runtime製品identity違反もdiskChecksPassedをfalseにする。manifest/packageの版は検査済み通常ファイルから読み、FIFO/symlinkを先に拒否する。Gitのshow-toplevelが実ROOTと異なる場合、親repoのHEADをcheckoutの版として返さない。
- transportのasync継続は現在socket・generation・enabledを確認し、旧socketのfailで現socketを閉じない。ready callbackの再入停止とpair finallyのownerも確認した。HMAC・認証context・ACKのprotocolは変更していない。
- 親のsource回帰は、独立に符号化したmarkerを使い、pin/overlay/patch/欠落/製品identity/未確認表示を検査している。実装担当のtransport回帰は、既存の実backend往復に加え、保存の外部ラッチ、timeout、置換、正の継続、今回2反例を検査している。wrapperが成功しただけの空のテストではない。
- 当担当は製品回帰スイートの実行・再構築を重複していない。共有runtimeでの最終回帰、再構築hash一致、公開候補manifestは統合担当の結果と別に照合する必要がある。旧303 PASS/1 TODOを今回候補の結果として再使用しない。

## 6. この結果から言えないこと

doctorの`diskChecksPassed=true`は、setup入力、overlay由来の準備済みfile、製品identity、指定した拡張の期待file群のdisk一致という意味である。継承runtime全体、targetの余分なfile、依存物全byte、起動中の本体、Chromeが実際に使用するworker/contentの版は証明しない。

実ロードフォルダーの未指定では`selectedExtension=null`が残る。別pathに同じcode byteがあればdisk一致にできるが、それをChromeが読込中とは扱わない。この範囲での合格を、計画J2の正の統合動作、J3のWindows限定試用、J4の社員配布へ繰り上げない。

bindingのprovider自動承認は追加していない。U01〜U23、正常5秒/復旧45秒/120秒の失敗区分、通知対象集合、未読・入力保護、自然worker停止、Windows2時間/復帰3回は原基準のままである。今回の45件をそれらの実利用試行数へ加算しない。

## 7. 対象sourceのhash

| file | SHA-256 |
|---|---|
| `scripts/prepare-runtime.js` | `7effe040a687c7bdae55360c7616e5008c7a5cf77bb23bfa343c476c547a8085` |
| `scripts/doctor.js` | `d9b933c07830cd60e76b21aa23c78a46eff79cb1cd6ace21a4a6fe2ba402fc65` |
| `scripts/run.js` | `3f942edb3daeebf5d423ee332e31571121de8dc180919e849b2b8ed6fae7c08b` |
| `package.json` | `a53298dd6dc9186effdb404661f6ac0b6f4140fd544b49eca23b6e1d2f2a8de1` |
| `check-windows.bat` | `bcaaf2393153227af7d9b9a749305baaeb223300306000ad0d2ac71f384c62e0` |
| `overlay/extensions/browser-bridge/transport.js` | `7fa68a88ab5cb480596bb6b067f4414f65b806983e84f6e8c37c4c6a0ef4121b` |
| `overlay/test/browser-extension-transport.test.js` | `1d636d581baacbdce522c2ebaa8fb7db63d6825a855d1cee5dbbb9106ac4b869` |
| `test/runtime-source.test.js` | `ee9e9a47679c363cdc9d3df95f5faee66dc5effdd1563493349042e8225ae9a4` |

driver: `/tmp/mori-next-independent-transport.js`、`/tmp/mori-next-independent-source.js`。
最終結果: `/tmp/mori-next-independent-transport-results.json`、`/tmp/mori-next-independent-source-results.json`。

source driver再実行前には`/tmp/mori-next-independent-fifos/fifo-1`〜`fifo-5`にFIFOを用意する。driverは自分のfixtureへrenameして使い、各fixtureを自分で削除する。Git/外部ネットワークの操作や共有runtimeの変更は実行しない。

## 8. 既存の実provider帰属証拠の最終確認

既存docs、review-evidence、adapter、fixtureを読み取り専用で確認した範囲では、実ChatGPT/Claudeの中央本文・操作部・会話の対応を裏付け、本番provider bindingを実装・有効化できる既存の観測証拠は見つからなかった。今回のbrowser接続不可を、既存のselectorや合成fixtureで補完できる状態ではない。この最終確認ではテストを再実行していない。

| 資料 | 実際に含む証拠 | 帰属についての限界 |
|---|---|---|
| `docs/verification-ja.md`の「ChatGPT の別形式の検知」 | 利用者提供の`mori-dom-v1`の生成中/生成後の要素数。短い停止ラベルと`aria-busy`が1から0へ変化し、入力候補は各1、従来assistant属性は0 | 同文書は要素数だけで同じフォーム内であることを証明しないと明記。本文・操作部と会話の対応、会話切替時の誤帰属反例を検証した記録ではない |
| `overlay/extensions/browser-bridge/adapters/chatgpt.js`と`claude.js` | 入力、停止、生成、assistantの候補selectorを使う実験的検知 | 既知のselectorや生成検知から会話の帰属を導く根拠はない。Claudeについても実際の会話対応の観測記録は見つからなかった |
| `overlay/test/browser-extension-fixtures.test.js`、`overlay/test/fixtures/recovery-independent-harness.js` | 合成DOM、明示的なpost-binding protocol stand-in、VM内でのconfirmed binding | 製品providerの観測ではない。fixture自身が実provider帰属の証拠としないと明記している |
| `docs/review-evidence/README.md`と`docs/review-evidence/recovery-017/chrome-recovery-results.json` | 合成protocol検証、およびChrome上の固定合成ChatGPT HTML。provider通信を遮断し実サービス/accountを利用しない試行 | 既存Chrome結果は`FAIL-no-recovery`。Chromeという実行環境を使ったことは、実provider DOMの観測を意味しない |
| `overlay/test/fixtures/recovery-independent-ledger-v1.json`のI-B8 | 実provider帰属を独立に調べるという受入要件 | 証拠がない場合はUNKNOWNとし、安全な隔離のPASSから有用な復旧へ繰り上げない要件であり、成功した試行記録ではない |

利用者の実観測が全く存在しないという判定ではない。既存の要素数観測は生成候補の検知を検討する材料になるが、会話の帰属を自動承認する材料には不足している。実providerのUI状態・観測条件と、中央本文・操作部・会話の同一性、会話切替前後の反例を対応付けた資料は確認できなかった。

`overlay/extensions/browser-bridge/conversation-binding.js`は実providerの検証済み根拠がないことをコメントし、`sample()`で`state: 'unconfirmed'`を返す。従って、**本番provider bindingは未実装/未確認のまま維持する。I-B8はUNKNOWN/未達、実サービス受入とWindows試用・社員配布はNO-GOのままである。** 今回の差分受入45件PASSを根拠にこの状態を変えない。
