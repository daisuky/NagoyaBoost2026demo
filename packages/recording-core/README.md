# @daruma-ikka/recording-core

同じworkspace内の相談アプリから利用する非公開パッケージです。利用側のdependenciesに `"@daruma-ikka/recording-core": "0.1.0"` を追加し、ルートで依存関係をインストールします。

```ts
import type { Recording, RecordingStore } from '@daruma-ikka/recording-core/types';
import { createAutoArchive } from '@daruma-ikka/recording-core/auto-archive';
import { qualityWindow } from '@daruma-ikka/recording-core/quality';
import { sendResumable } from '@daruma-ikka/recording-core/upload';
```

`createAutoArchive` は保存実装 `store`、送信処理 `upload`、通知コールバックを受け取り、直列化・重複排除・再試行を共有します。時計 `now` と排他 `withLock` も交換できます。既定の排他処理は利用可能ならWeb Locksを使用します。

現段階ではDrive保存の契約を維持しているため、型・権限名・通知文言にDrive固有の名称が残っています。任意の保存サービス用の汎用SDKではありません。

`qualityWindow` は通話統計の品質低下を判定する純粋関数です。`sendResumable` はGoogle方式の308応答とRangeによる再開を扱い、fetchを注入できます。

`types` はTypeScript型専用です。MediaRecorder、IndexedDB、WebRTC、画面、サーバー認可はアプリ側に残しています。ネイティブではBlobやfetchなどの環境適合を確認してください。

相談IDと録音IDを区別し、録音・保存の同意を文字起こし・AI利用の許可として扱わない契約を維持します。
