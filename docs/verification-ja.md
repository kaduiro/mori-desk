# 検証状況と社員配布までの工程

対象: Mori Desk `0.1.1-preview.1` / 拡張機能 `0.1.2` / 2026-10-20（日本時間）

**現時点はソースを取得して実験できる開発プレビューです。Windows / Mac で確認済みの
完成版、またはインストーラーの公開版ではありません。**

## 初版で実施済み（0.1.0-preview.1）

| 項目 | 結果 | 何が確認できるか |
|---|---|---|
| 固定ソースの再取得と組み立て | 成功 | 指定 commit の Git object から 1,259 個のコード等のファイルを読み、patch と overlay を適用できる |
| 依存関係の準備 | 成功 | `npm ci` で 334 パッケージを準備し、Electron 41.10.4 の実体を確認できる |
| Mori 素材 | 28 ファイルを生成・検証 | 上流の画像を取り込まず、SVG / PNG / ICO をソースから作れる |
| Browser / Mori 自動テスト | **73 / 73 成功、スキップなし** | 認証、状態、保存、再接続、タブ識別、フォーカス競合、CLI 隔離を確認 |
| 関連する既存 CLI テスト | **57 / 57 成功、スキップなし** | native hook の Origin 等の拒否、runtime 書き込み失敗、ポート選択、フォーカス、状態優先度を確認 |
| 実際の loopback HTTP / WebSocket | 成功 | 実ソケットでペアリング、保存 ACK、再接続、失効、HTTP discovery の隔離を確認 |
| Electron の起動 | Linux テスト画面で成功 | 組み立て後のアプリ、接続画面、Mori 素材の読み込みを確認 |
| HUD の表示 | Linux + 合成セッションで確認 | CLI の「許可待ち」、ChatGPT の「回答を確認」、Claude の「生成中」の 3 行と未確認ベルを描画。横方向のはみ出しなし |
| セットアップの失敗時 | 旧 runtime 保持を確認 | Electron のバイナリ取得をテスト用に止め、検証失敗時に実行中コードと marker が置き換わらないことを確認 |
| About / 更新 / 拡張フォルダー | 静的・モジュール検証 | Mori の表示、手動更新、`app.asar.unpacked` への実フォルダー解決を確認 |

実行環境は Linux x64、Node.js 24.19.0、Electron 41.10.4 です。
GUI の確認には隔離したテスト用データと仮想ディスプレイを使いました。
この環境は OS の保護された鍵保存を利用できないため、実アプリがペアリングを
停止し、理由を表示することを確認しています。プロトコルテストはテスト用の
safeStorage を注入しており、Windows DPAPI / macOS Keychain の確認にはなりません。

失敗再現後の作業ディレクトリはテスト環境で残存が観測されたため、終了済みの
テスト所有者を確認して当該 staging / lock だけを整理しました。Windows でも
中断後の lock と再実行手順を確認してください。旧 runtime を保持したことと、
あらゆる環境で一時ファイルが自動整理されることは別の確認項目です。

### 再現コマンド

以下は Node/npm が PATH にある開発環境でのコマンドです。
BAT が準備した専用 Node の利用者は、通常のセットアップ・起動に各 BAT を使ってください。
Windows ではリポジトリのルートで:

```powershell
npm.cmd run setup
npm.cmd run verify:electron
npm.cmd test
```

関連 CLI テストを追加で確認する場合:

```powershell
cd .runtime
node --test --test-reporter=spec test/server-permission-ingress.test.js test/server-runtime-write.test.js test/server-start-http.test.js test/session-focus.test.js test/state-priority.test.js
```

上流の全テストは実行していません。Mori の変更により、上流製品名・既定設定・
除外した素材を前提にするテストはそのままでは一致しません。

## 未検証・初期対応の範囲外

- Windows の Explorer からの手動起動、透過・最前面・DPI・複数画面の手動確認。
- Windows ARM64 上での Node 自動導入の実行。ARM64 ZIP 自体の取得・ハッシュ検証は実施済み。
- Windows 上での NSIS EXE 作成、インストール、更新、アンインストール。
- macOS のビルド、Keychain、署名・公証、Spaces、全画面、Finder / Chrome 操作。
- Chrome 本体への拡張読み込み、CSP の適用、localhost / loopback の許可、会社の管理ポリシー。
- 実際の ChatGPT / Claude、利用者のアカウント・UI 言語・A/B テストごとの DOM。
- 実ブラウザのスリープ、復帰、タブ破棄、ブラウザ再起動後の回復。
- 音声、画像・動画、Deep Research。カスタム GPT / Projects の通常会話パスは
  拡張機能 0.1.1 で受理するが、実サービスの固有 UI・機能は未検証。
- upstream アプリからの設定・hook の自動移行、両アプリの CLI 同時管理。
- 長期運用向けの保存履歴整理。初期版は上限到達を明示し、暗黙に未確認を削除しない。
- 継承した任意の外部通知、PWA、リモート操作など、ブラウザ HUD 以外の全機能。

ブラウザの `completed` はこの版の adapter から生成しません。
「回答を確認」は生成が落ち着いた候補の通知で、回答の完全性や正常終了の証明ではありません。

## Node.js 自動準備の追加検証

2026-10-19、Node の準備処理を追加して以下を確認しました。

| 項目 | 実測結果 |
|---|---|
| Node.js 24.22.0 の公式 Windows ZIP | x64 / ARM64 を実際に取得。固定 SHA-256、ZIP の整合性、Node / npm / LICENSE の同梱を確認 |
| Node の互換性判定 | Linux 上で 4 テスト成功。下限・別 major・プレビュー版・npm 不在を確認 |
| Windows Server 2022 x64 の CI | **10 テスト成功、失敗・スキップなし**。未導入からの公式 ZIP 導入、再利用、特殊文字のパス、引用符付き PATH、失敗コード、ハッシュ不一致を確認 |
| Mori の再構築と既存テスト | Linux / Node 24.19.0 で再構築成功。Browser / Mori の 73 テストも再実行し、すべて成功 |

Windows の実行記録: [Windows Node bootstrap / 成功した実行](https://github.com/kaduiro/mori-desk/actions/runs/39269532172)
（コード commit `48febfb4b95574a4d7f4103b9a70cb925dd23bbc`）。
チェックアウト時の改行変換で問題が隠れないよう、CI は Git の blob から BAT を読み、
GitHub の ZIP と同じバイト列を実際の `cmd.exe` / Windows PowerShell で実行します。

Node のダウンロード、ハッシュ検証、展開、Node / npm のバージョン確認は実処理です。
アプリに処理を渡す部分は一時フォルダーの小さなスクリプトへ差し替えて、選択した Node、
引数、終了コードと既存 runtime の保持を検査します。Mori の GUI・Electron の Windows
インストール・Chrome 連携の実機確認とは区別してください。

開発環境での再現コマンド:

```powershell
node --test --test-reporter=spec test/check-windows-node.test.js test/windows-node-bootstrap.test.js
```

Windows 以外では BAT の統合テストを明示的にスキップします。

## セッション未表示・ショートカット通知の修正（0.1.1-preview.1）

ユーザー報告を受け、ショートカット失敗を設定保存の失敗と誤解させる通知、日本語設定の
到着前に英語で通知する競合、ブラウザ用モードから CLI ダッシュボードを開く経路を修正しました。
ChatGPT の `/g/…/c/…` 会話パス、拡張機能のタブ診断、セッションがない HUD の接続案内も追加しました。

| 項目 | 結果 |
|---|---|
| Linux で固定 source + patch + overlay を再構築 | 成功。最終入力と実行環境の対象81ファイルがバイト単位で一致 |
| Browser / Mori の個別回帰テスト | **99 件成功・失敗0・スキップ0** |
| 変更に関係する既存 HUD・設定ウィンドウ・ショートカットのテスト | **124 件成功・失敗0・スキップ0** |
| 新しい URL と画面遷移 | 同じ scope の新規会話だけを引き継ぎ、別 scope への移動直後の focus / ACK を拒否。合成 DOM と reducer で検証 |
| タブ診断のプライバシー | 最大20タブの件数のみ。URL・scope名・タイトル・本文が診断結果や送信イベントへ混入しないことを検証 |
| 接続案内の HUD | 実セッション数・未確認を増やさず、DND / 非表示 / ミニモード等の制約を維持。合成 renderer で確認 |
| Windows での再構築・回帰・ネイティブ起動 | Windows Server 2022 で99件＋124件成功、失敗0・スキップ0。本体起動、保護された保存先の準備、接続待ちHUD、ブラウザ連携画面へのIPCも成功 |

この節のローカル実行環境は Linux x64 / Node.js 24.19.0 / Electron 41.10.4 です。
`.github/workflows/mori-regression.yml` には Windows 上での再構築・同じ回帰テストと、
実際の Electron main / HUD / ブラウザ連携画面の起動検査を用意しています。
Windows 起動検査は専用の一時データを使い、実際の Chrome や AI 会話には接続しません。

Windows の成功した実行: [Mori browser and HUD regression](https://github.com/kaduiro/mori-desk/actions/runs/39281525397)
（対象コード commit `38c34a6f630ca08579d96bd2ebaedf8c9be479dd`）。
前の記録時には割り当て待ちでしたが、その後の実行ログで Windows 上の個別テストと
ネイティブ起動の成功を確認しました。上の99件・124件は Linux と Windows の両方で完了しています。

再現コマンド（リポジトリのルート、対応 Node が PATH にある環境）:

```powershell
npm.cmd run setup
npm.cmd test
node --test --test-reporter=spec .runtime/test/session-hud.test.js .runtime/test/settings-window.test.js .runtime/test/shortcut-actions.test.js .runtime/test/shortcut-runtime.test.js
node scripts/smoke-windows-ui.js
```

最後のコマンドだけ Windows 専用です。手動の Chrome 拡張読み込み、本番 DOM、OS の
グローバルキー競合、DPI・複数モニター・全画面、macOS の検証は別に必要です。

## 拡張更新後のエラー・再接続待機の修正（拡張機能0.1.2）

Chrome のエラー画面で報告された `Extension context invalidated` に対し、ページ側の
`sendMessage()` が Promise を返す前に例外を投げる場合を再現しました。古い監視処理が
停止しない問題も修正し、DOM監視・タイマー・イベントリスナーを解除します。
一時的な Service Worker の不在やメッセージポートの切断では監視を継続します。

また、自動再接続の待機中に通常の観測処理が探索を繰り返す問題を再現しました。
5候補への接続失敗後に20回の観測を行うテストでは、修正前は105回の接続試行が発生し、
修正後は予定された再試行まで5回のままです。「今すぐ再接続」だけは待機を解除します。

- 固定 upstream + patch + overlay から再構築成功。
- Linux x64 / Node.js 24.19.0 で **108件成功・失敗0・スキップ0**。
- 同期／非同期例外の停止、一時的な障害からの回復、待機・明示再試行、ポート変更後の
  実ローカルサーバーとの相互認証、既存のscope／focus／ACKを検証。
- 変更は拡張機能と文書です。デスクトップ本体のバージョンは `0.1.1-preview.1` です。

接続拒否の記録があった時点の Windows プロセス・ポートの状態は、画像だけでは
確定できません。実際のChromeでの更新・会話タブの再読み込み・本体起動後の再接続は、
[Windows手順](windows-ja.md)で確認してください。古いエラー記録だけでは現在の接続状態を判定しません。

## Windows での受け入れ手順

最初は機密を含まないテスト用の普通の会話を使います。

| 操作 | 期待する結果 |
|---|---|
| 初回 BAT、接続コード、拡張の接続 | Mori のウィンドウが開き、接続済みが表示される |
| ChatGPT のタブで質問する | 一つの行が「生成中」になる |
| 生成が落ち着く | 「回答を確認」と未確認ベルが出る |
| HUD の該当行を押す | その会話タブへ戻り、成功した通知だけ確認済みになる |
| 未確認のまま次の質問 | 次の生成中表示と前の未確認が同じ行に残る |
| ChatGPT と Claude、同サービスの複数タブ | 別々の行で更新され、一方の終了で他方の生成中を消さない |
| 自分で停止する | 観測できた停止操作は中断になり、正常終了を出さない |
| タブを閉じる・別会話へ移動する | 閉鎖や観測不明を表示し、別のタブに誤って戻らない |
| Mori / Chrome を終了・再起動する | 未確認が消えず、過去の回答を開いただけでは新しい完了通知を出さない |
| ペアリングを解除する | 対象プロフィールの接続と保存メタデータが消え、再接続に新しいコードが必要になる |
| セットアップをネットワーク失敗で中断する | 旧 runtime は残り、再実行時のエラーと lock の手順が理解できる |

不具合報告には OS、Chrome、サービス、UI 言語、操作順、Mori / 拡張のバージョンを
記録してください。会話本文や会社の情報を含むスクリーンショットは不要です。

## 社員の Mac へ配布するまで

1. **Windows の通常会話を検証する。** 実 DOM に合わない selector を provider ごとに直し、
   不明状態・停止・再接続のケースを追加します。生成中の検知と未確認の維持を最初の判定項目にします。
2. **Windows インストーラーを作り、クリーンなテスト環境で確認する。**
   BAT / Node / Git を使うのは開発者側です。社員側はビルド済みアプリを利用します。
3. **Mac runner でビルドし、代表的な社員 Mac で検証する。**
   Apple Silicon / Intel の必要な構成、表示、Keychain、権限、フォーカス、スリープ復帰を確認します。
4. **署名・公証と、組織が管理する拡張配布を整える。**
   組織の拡張 ID とデスクトップ側の許可 ID を合わせます。開発者モードは技術検証用です。
   社内管理のない一般 PC への拡張の無断導入は実装しません。
5. **小人数で試用し、保守方法を決める。** 画面変更時の担当、更新レビュー、
   署名鍵の管理、履歴容量、障害時の戻し方を決めます。バイナリを配布する際は、
   その正確なソース revision と再構築可能な build inputs を一緒に提供します。

## 一次資料

- [固定した上流コード](https://github.com/rullerzhou-afk/clawd-on-desk/tree/384a9322972c46d17122845bcc26e5b4b90e670c)
- [Chrome WebSocket service worker](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
- [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)

実測・テスト結果の根拠は、本リポジトリの対象テストと上記の再現コマンドです。
