# 起動時の `read ECONNRESET` ダイアログの調査・修正

記録日: 2026-11-06（Asia/Tokyo）。対象は利用者が提示した、Mori Desk の「A JavaScript error occurred in the main process / Error: read ECONNRESET」という画像。画像は 22:01 ごろ作成され、常用 worktree は旧版 `590dd92` の runtime だった。画像だけでは切断した相手のプロセスやソケットを特定できず、端末ログにもこの例外の追加スタックは残っていない。

## 確認できた欠陥

ブラウザー連携の HTTP Upgrade ハンドラは、拒否した接続に HTTP 応答を書き、対象外の Upgrade は別の所有者に任せる。一方、Upgrade 後の生 TCP ソケットに `error` リスナーを付けていなかった。応答中または受け渡し前に相手が接続をリセットすると、ソケットの `error` イベントが Electron のメインプロセスで未処理となる。`read ECONNRESET` の画像と整合する経路である。

修正前の再現テストでは、拒否した Upgrade ソケットへ `ECONNRESET` を発生させると `read ECONNRESET` が未処理例外となり失敗した。修正は Upgrade ソケットだけに `error` ハンドラを登録し、通信エラー時に当該ソケットを破棄する。プロセス全体の `uncaughtException` を握りつぶさず、WebSocket の認証、厳密な Origin／Host、永続 ACK、未読状態を変更しない。対象外パスで他の所有者がソケットを引き受ける場合も、その間のエラーを処理する。

この再現は欠陥と修正効果を示すが、画像の元の接続が必ず同じソケットだったとまでは証明しない。修正版で同じダイアログが再発する場合は、起動方法、発生時刻、完全なスタックを秘密情報を伏せて取得し、別の経路を調べる。

## 検証と試験用候補

- 修正前の対象テスト: 失敗（`read ECONNRESET`）。修正後: 成功。
- `npm run setup`: 独立 worktree の再構築成功。`npm run doctor -- --json`: `source_check_passes (source_matches)`。常用 worktree の runtime はこの時点で保持。
- `npm test`: 902件中900成功、失敗0、skip 1、TODO 1。実際のループバック WebSocket の認証・永続 ACK を含む既存試験も成功。
- `npm run build:win:x64`: 成功。試験用 Setup は `Mori-Desk-Setup-0.1.3-preview.1-x64-reset-fix-candidate.exe`、111,263,029 bytes、SHA-256 `55B98BF7A35C726B870E4279BBD5748E37075EC16C93D1B70500AD01955E49E1`、Authenticode `NotSigned`。Git 管理外の独立 worktree `.runtime/dist/` にあるローカル候補で、公開・インストール受入は未実施。

インストール試験では、このハッシュとファイル名を照合する。まず起動・Chrome 拡張の再接続で同じダイアログが出ないことを観察し、続いてショートカット・HUD 設定保持・終了後の再起動・アンインストールを確認する。未署名による OS 警告は別に記録し、OS 保護機能を自動で迂回しない。
