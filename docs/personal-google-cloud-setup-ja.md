# 個人 Google Cloud で Calendar・Gmail を接続する

この手順は本人管理の Google Cloud プロジェクトを使う短期試験向けです。Google の画面、利用枠、請求条件、OAuth の審査条件は変更されるため、作業時に Cloud Console と公式説明を確認してください。API を有効にするだけで無料利用や一般公開が保証されるわけではありません。

1. [Google Cloud Console](https://console.cloud.google.com/) で、自分が管理するプロジェクトを選ぶか作成する。プロジェクト ID、請求先の有無、Gmail API・Google Calendar API の実効枠を Console で確認する。Mori Desk は Cloud 管理権限を要求しない。
2. Gmail API と Google Calendar API を有効にする。Cloud Run や Pub/Sub は使わない。
3. Google Auth Platform でアプリ名、対象ユーザー、データアクセス、連絡先を確認する。External / Testing なら接続する Google アカウントをテストユーザーに追加する。Workspace のアカウントは組織管理者側の制限も確認する。
4. 「デスクトップ アプリ」型 OAuth クライアントを Calendar 用と Gmail 用に作る。Calendar の必要権限は `calendar.events.readonly` と `calendar.calendarlist.readonly`、Gmail は `gmail.readonly`。JSON は他者へ送らず、チャットや Git に貼らない。
5. Mori Desk の「今日の予定」設定と「受信メール」設定から、それぞれの JSON をファイル選択で取り込む。Google の同意画面では接続したいアカウントを確認する。両 HUD で初回同期と「更新」を試し、Chrome でメールのリンクを開いてアカウントが一致するか確認する。

External / Testing の Gmail 権限などを使う更新トークンは通常 7 日で失効します。継続利用や不特定多数への公開は、OAuth の公開状態、制限付きスコープの審査と例外の適用範囲を別途確定してから行います。JSON の形式を検査できても、Mori Desk だけでは Cloud プロジェクトの所有者、請求先、実効枠は検証できません。

OAuth JSON、認可コード、トークンをエージェントへ渡さないでください。支援用プロンプトはアプリ内「個人 Google Cloud の準備方法」にあります。ログイン、規約、請求先、OAuth 同意は本人が操作します。

公式説明: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[公開状態](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)、[Gmail API の枠](https://developers.google.com/workspace/gmail/api/reference/quota)、[Calendar API の枠](https://developers.google.com/workspace/calendar/api/guides/quota)。
