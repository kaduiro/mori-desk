# Windows でのセットアップと実験

このリポジトリは **Mori Desk の開発プレビュー**です。固定した
clawd-on-desk のソースに Mori の変更を適用し、オリジナルのキャラクターと
ブラウザ連携を試すための構成です。

実際の ChatGPT / Claude の画面での DOM 判定、Windows / Mac の GUI、
署名済みインストーラーの動作は、社員へ配布する前に実機で確認してください。
ローカルの自動テストが通っても、それらが確認されたことにはなりません。

## 1. 開発用 PC の準備

Windows の通常のデスクトップ環境で実行します。最初は Windows x64 と
Chrome を対象にします。Electron のウィンドウ確認には Windows 側の
PowerShell または BAT を使ってください。

最初に次を各公式インストーラーから入れてください。

- [Node.js](https://nodejs.org/en/download)：**24.18.0 以降の 24.x LTS**。
  `.nvmrc` の開発基準は 24.18.0 です。npm もインストールします。
- [Git for Windows](https://git-scm.com/install/windows)
- [Google Chrome](https://www.google.com/chrome/)

インストール後は PowerShell を開き直して確認します。

```powershell
node --version
npm.cmd --version
git --version
```

BAT は Node / Git を自動インストールしません。管理者権限や PowerShell の
実行ポリシー変更も要求しません。会社の PC では社内のソフトウェア配布手順を
使ってください。

## 2. Mori Desk を入手する

```powershell
git clone https://github.com/kaduiro/mori-desk.git
cd mori-desk
```

GitHub の Code → Download ZIP から入手して展開する方法でも構いません。
この場合も、固定 upstream を取得するセットアップ処理には Git が必要です。

## 3. 初回は setup-windows.bat

`setup-windows.bat` をダブルクリックします。成功すると、そのままブラウザ用
モードの Mori Desk を起動します。コマンドで同じ作業を行う場合は：

```powershell
npm.cmd run setup
npm.cmd start
```

初回セットアップでは次の処理を実行します。

1. `upstream.lock.json` に記載した repository と commit を確認します。
2. upstream を `.upstream/clawd-on-desk` に取得し、固定 commit の Git blob を
   読み出します。キャッシュ内の未追跡ファイルやローカルの書き換えはコピーしません。
3. upstream の artwork / themes / Git metadata を除外して専用 staging を作ります。
4. `patches/mori.patch` と `overlay/` を適用します。
5. Node のコードから Mori の SVG、PNG、ICO を生成します。
6. staging 内で `npm ci` を実行し、Electron と生成素材を確認します。
7. すべて成功した後に `.runtime` を切り替えます。

処理中はアプリの dependencies をダウンロードするため、ネット接続と空き容量が
必要です。既存の `.runtime` がある場合、途中で失敗した staging に置き換えません。
生成ディレクトリの所有権が確認できなければ、削除や置き換えを止めます。

## 4. ブラウザ拡張機能を一度読み込む

Chrome で `chrome://extensions` を開き、開発者モードを有効にして
「パッケージ化されていない拡張機能を読み込む」を選びます。

選ぶ場所は、セットアップで生成した `.runtime/extensions/browser-bridge` です。
そのフォルダーの `manifest.json` が存在することを確認してください。

読み込み後、Mori Desk のブラウザ接続画面で発行するペアリング情報を、
拡張機能の設定画面に登録します。実際のボタン名と接続方法はリポジトリの
README のブラウザ接続手順を参照してください。

既に開いていた ChatGPT / Claude のタブは、拡張機能の初回読み込み後に
再読み込みしてください。最初は通常のテキスト会話で試します。

開発者モードの拡張読み込みは技術検証用の方法です。社員向けの恒久配布では、
組織管理の拡張機能配布または組織が所有する配布経路を別途用意します。
デスクトップの BAT / EXE だけで Chrome の任意の拡張機能や権限を無断で
登録する仕組みにはしていません。

## 5. 2 回目からの起動

`start-windows.bat` をダブルクリックするか、次を実行します。

```powershell
npm.cmd start
```

通常の起動では upstream の再取得、パッチの再適用、`npm ci` は行いません。
検証済みの `.runtime` をそのまま起動します。

Mori のソースを更新したときは、Mori Desk を終了してから
`npm.cmd run setup` を再実行してください。拡張機能に変更があれば
`chrome://extensions` で再読み込みし、対象の AI タブも再読み込みします。

## 6. CLI も使う実験

**元の Clawd on Desk と、通常モードで起動中の Mori Desk を終了してから**
`start-cli-windows.bat` を使います。

```powershell
npm.cmd run start:cli
```

このプレビューでは元の Clawd の設定を自動移行しません。同じ OS ユーザーで
二つのアプリに CLI hooks / runtime を同時管理させないでください。
必要な CLI 連携は Mori の設定画面で明示的に有効にします。
権限承認などの追加機能も、必要な範囲を確認して設定画面から有効にしてください。

ブラウザ専用の実験に CLI モードは不要です。

このプレビューでは CLI からのアプリ自動起動を無効にしています。先に専用 BAT で
Mori を起動してください。OS ログイン時の起動を設定した場合もブラウザ用モードに
なるため、CLI を使う場合は起動中の Mori を終了して専用 BAT から起動し直します。

## 7. Windows の EXE インストーラーを作る

Windows でセットアップが成功したら、`build-windows.bat` または次を実行します。

```powershell
npm.cmd run build:win:x64
```

生成先：

```text
.runtime/dist/Mori-Desk-Setup-0.1.0-preview.1-x64.exe
```

ビルドスクリプトは GitHub Release へ自動公開しません。この段階の unsigned
preview を、署名済み・社員向けの完成版と扱わないでください。Windows の署名や
社内配布方法は、実機テスト後に整備します。

ビルド済み Electron アプリはランタイムを同梱するため、将来の社員向け
インストーラーでは社員に Node / Git を用意してもらう必要はありません。
拡張機能の導入と初回ペアリングは別の工程として残ります。

Mac 用の `.app` / `.dmg` は Mac の CI runner で作れます。署名・公証と
社員の Mac でのウィンドウ、最前面表示、スリープ復帰、タブへの移動の確認が
必要です。Windows の結果だけで Mac の動作確認済みとはしません。

## 8. 自動テストと実機チェック

```powershell
npm.cmd run verify:electron
npm.cmd test
```

テスト対象は `.runtime/test/browser-*.test.js` と `mori-*.test.js` です。
Windows でも shell glob に頼らず、実在するファイルを列挙して実行します。

実機では少なくとも次を確認します。

- 一つのタブで生成開始 → 生成終了 → HUD の通知 → 元のタブへ戻る。
- 複数タブで、一方の生成が終わっても他方の実行中表示が残る。
- 生成の中断、エラー、観測できなくなった状態を「正常終了」と誤表示しない。
- HUD を押しても対象タブを開けなかった場合、未読を失わない。
- Chrome / Mori の再起動、スリープ復帰、タブの再読み込み。
- 会社の Windows / Mac で、表示倍率と複数ディスプレイを変えても操作できる。

## 9. うまくいかないとき

### Node のバージョンが合わない

Node 24.18.0 以降の 24.x を入れ、端末を開き直します。
`where.exe node` で複数の Node が見つかる場合は、利用したいものが PATH で
先に来るよう開発環境を整えてください。

### npm.ps1 の実行ポリシーエラー

上の手順どおり `npm.cmd` を使用してください。BAT 内の処理は Node から
npm の JavaScript CLI を直接起動し、PowerShell の実行ポリシー変更は行いません。

### ダウンロード・dependency の準備に失敗した

エラーの repository URL / npm / Electron のメッセージを確認します。
社内 proxy・証明書・ネットワークに制約がある場合は社内の設定を使います。
証明書検証を無効にする設定は不要です。通信が直ったらセットアップを再実行します。

### 所有権エラー

`.runtime` / `.upstream` が別のプロジェクトからコピーされた、別の場所へ
移動された、または marker がない場合は自動上書きを止めます。
既存データを保管し、新しい空のフォルダーに Mori の repository を取得して
セットアップし直す方法が確実です。個人の CLI 設定を削除する必要はありません。

### .mori-setup-lock が残った

セットアップ中に端末や PC が終了すると lock が残ることがあります。
別の Mori セットアップが動いていないことを確認してから、プロジェクト直下の
`.mori-setup-lock` だけを取り除いて再実行します。不明なプロセスを一括終了したり、
ユーザーの `.claude` / `.codex` / `.clawd` を削除したりしないでください。

### HUD は表示されたが AI の状態が出ない

拡張機能が有効か、ペアリングが完了しているか、対象の AI タブを初回読み込み後に
再読み込みしたかを確認します。AI 側の画面構成変更で DOM adapter の修正が
必要な可能性もあります。回答文や社内文書の内容をログや issue に貼る必要はありません。
