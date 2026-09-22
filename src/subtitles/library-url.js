/**
 * 文字起こしライブラリ（transformers.js）の読み込み元。
 *
 * ## `+esm` でなければならない
 * 公式が配っている `dist/transformers.web.js` は、**名前だけのimportを含んだまま**
 * 配布されている。
 *
 *   import * as ONNX_WEB from "onnxruntime-web/webgpu";
 *
 * ブラウザはこの書き方を解決できないので、読み込んだ瞬間に落ちる。
 *
 *   Failed to resolve module specifier "onnxruntime-web/webgpu".
 *
 * バンドラを使う前提のファイルで、ビルド工程を持たないこのアプリでは使えない
 * （実機で発覚。exportされている関数を調べるだけでは分からなかった）。
 * jsDelivr の `+esm` は依存を解決した形を返すので、そちらを読む。
 *
 * ## 版を固定する理由
 * 勝手に上がって動かなくなるのを防ぐため。上げるときは
 * `npm run test:transcribe` で最後まで走ることを確かめてから。
 */
export const TRANSFORMERS_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
