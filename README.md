# Ippo Recording — 公開ソース版

二者通話、双方同意、話者別録音、IndexedDB保存、Google Driveへの送信・再送を備えたReact PWAの公開用スナップショットです。

- `apps/recording`：PWA、Vercel API、Cloudflare Worker、未署名のCapacitor iOSプロジェクト。
- `packages/recording-core`：型、通話品質判定、アップロードと再送の共通部品。同梱workspaceなので、非公開npmレジストリへの接続は不要です。

公開元：NagoyaBoost2026の録音モジュール（2026-10-27時点）。公開用に個人設定を外した独立スナップショットです。元のGit履歴、運用文書、Drive画面の画像、認証情報、録音データは含めていません。元の稼働環境との接続や自動同期はありません。

## 起動

Node.js 22.12以上。リポジトリルートで実行します。

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run dev
```

画面は `http://127.0.0.1:5173`、APIは8788番です。setupはこの環境専用の秘密値を `apps/recording/.env` に生成します。外部サービス未設定でも画面とマイクテストを確認できます。実通話・Drive保存には [独自の接続設定](apps/recording/README.md) が必要です。

```powershell
npm.cmd run check:public
npm.cmd test
npm.cmd run build
```

## 公開と配置

VercelのRoot Directoryは `apps/recording`。ルート外のソースをビルドに含め、Install Commandは `cd ../.. && npm ci`、Build Commandは `npm run build`、出力は `dist` にします。秘密値はVercelとWorkerの非公開環境変数へ登録します。

Cloudflare Worker名は公開用に `ippo-demo-signaling` としています。自分の配置先として一意の名前に変更してからデプロイしてください。iOS署名鍵・証明書・プロビジョニングは付属しません。自分のApp ID・署名設定を用意してください。

公開前の扱いは [秘密情報の管理](SECURITY.md) を参照してください。このリポジトリの公開は、元の稼働PWAの配置やGoogle接続を変更しません。
