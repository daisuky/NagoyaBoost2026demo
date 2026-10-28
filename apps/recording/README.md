# 一歩の記録：公開版の設定

このアプリは自分のVercel・Cloudflare・Google Driveへ接続して利用します。他の運用者の保存先や接続情報は付属しません。依存関係はリポジトリルートで `npm ci` を実行します。

## 環境変数

`npm run setup` が生成する `apps/recording/.env` に設定します。秘密値へ `VITE_` を付けないでください。

| 項目 | 設定内容 |
| --- | --- |
| `APP_SESSION_SECRET`, `IPPO_ACCESS_CODE`, `SIGNALING_SERVICE_SECRET` | setupで個別生成。通話作成の合言葉と署名・サービス認証に使用 |
| `CF_SIGNALING_URL` | 自分のWorkerのHTTPS URL |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | 自分のTURN接続情報 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 自分で登録したGoogle OAuthクライアント |
| `GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_ID` | 自分のGoogle接続セットアップで取得 |
| `GOOGLE_DRIVE_TARGET_FOLDER_ID` | 任意。選択を制限する自分のフォルダーID |
| `ARCHIVE_LABEL` | 保存を担当する運用者・チームの表示名 |
| `VITE_API_BASE_URL` | PWAは空欄。同一オリジンのAPIを使用 |
| `ALLOWED_ORIGINS` | 自分の追加オリジンのみ。ネイティブなら `capacitor://localhost` を追加 |

## Google Drive

Google CloudでDrive API・Picker APIとOAuthクライアントを用意し、リダイレクトURIに `http://127.0.0.1:53682/callback` を登録します。利用する権限は `drive.file` です。

接続アカウントが追加権限を持つ、適切にアクセス制限したフォルダーを用意します。ルートで `npm run drive:setup --workspace=ippo-recording-session` を実行し、自分のアカウントで認証・フォルダー選択を行います。接続情報はローカルの.envに保存されます。Vercelへは非公開設定として登録します。

## Cloudflare

自分のTURNキーを.envへ設定し、`npm run signaling:deploy --workspace=ippo-recording-session` でWorkerを配置します。wrangler.jsoncのWorker名は、自分用の一意な名前にしてください。Workerに `SIGNALING_SERVICE_SECRET` を登録し、同じ値とWorkerのURLをVercelへ設定します。これらのコマンドは自分の外部環境を変更します。

## 端末登録と通知

初期状態の `IDENTITY_CALLING_ENABLED=0` では端末・電話帳の登録を無効にしています。招待による通話とは別に、運用準備後に有効にしてください。

通知を利用する場合、先に.envの `WEB_PUSH_SUBJECT` に自分のHTTPS URLまたはmailto:連絡先を記入し、`npm run notifications:setup --workspace=ippo-recording-session` を実行します。自分用のVAPID鍵が.envに生成されます。既存の鍵は上書きしません。Vercelに通知設定を登録し、各端末で通知許可を取得します。

## 動作確認と制約

二者の同意後に作成者が両者の音声を混ぜ、一つの会話音声を録音します。画面切り替えだけでは通話・録音を止めません。同意撤回・接続障害・音声処理中断等では録音を停止します。正常終了した未送信録音は次回起動や通信復帰時に再送し、中断録音は手動確認が必要です。文字起こし・AI分析は実行しません。iPhoneの背景動作や長時間録音を保証するものではありません。

ローカルの `/qa/peer.html` と `/qa/recording.html` で合成音声の検証ができます。実TURN検証は自分の環境変数と `IPPO_ENABLE_TURN_QA=1` が必要です。配置済みAPIへのQA転送は、さらに `IPPO_QA_API_ORIGIN` に自分のHTTPSオリジンを設定した場合のみ利用できます。未設定時は外部へ転送しません。

公開前に `public/privacy.html` の問い合わせ先・保存方針を、自分の運用に合わせて更新してください。公開版のビルド・自動テストは実サービスやiPhone実機の検証を代替しません。

[リポジトリの案内](../../README.md)
