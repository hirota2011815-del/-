# vendor/

外部ライブラリをそのまま置いています（ビルド不要・静的ホスティングでそのまま配信するため）。

| ファイル | 中身 | バージョン | ライセンス |
| --- | --- | --- | --- |
| `mediabunny.min.mjs` | [Mediabunny](https://github.com/Vanilagy/mediabunny) の ESM ビルド | 1.58.1 | MPL-2.0 (`LICENSE.mediabunny.txt`) |

## なぜ mp4box.js + mp4-muxer ではなく Mediabunny なのか

当初の技術構成では mp4-muxer を指定していましたが、mp4-muxer は作者自身によって
非推奨（deprecated）となり、後継の Mediabunny へ移行するようアナウンスされています。
Mediabunny は同じ作者による後継ライブラリで、mux（書き出し）だけでなく demux（読み込み）も
担当するため mp4box.js も不要になります。

このアプリにとって決定的だったのは次の2点です。

1. **`BlobSource` がファイルを遅延読み込みする。** mp4box.js は解析前にファイル全体を
   `ArrayBuffer` としてメモリに載せる必要があり、30分のスマホ動画（数GB）では
   iOS Safari のタブが落ちます。Mediabunny は必要な範囲だけを `Blob.slice()` で読みます。
2. **`EncodedPacketSink` / `EncodedVideoPacketSource` がある。** フィルターも速度変更も
   していないクリップを再エンコードせずそのまま通す「無劣化パススルー」を、
   後のステップで素直に実装できます。

更新するときは `npm pack mediabunny` で取得した `dist/bundles/mediabunny.min.mjs` を
差し替えてください。
