/**
 * 文字起こしを「ネットに出ずに」最後まで走らせるための、モデル一式の取り寄せ。
 *
 *   node test/offline-transcribe/fetch.mjs
 *
 * 落としたものは test/offline-transcribe/mirror/ に置く（約83MB・gitには入れない）。
 * 一度落とせば run.mjs は何度でもオフラインで走る。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSFORMERS_URL } from '../../src/subtitles/library-url.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, 'mirror');

/** 検証用には一番小さいモデルで足りる（通る／通らないを見るのが目的）。 */
const MODEL = 'onnx-community/whisper-tiny';

/**
 * ONNX Runtime のバージョン。同梱した transformers.js が参照している版に合わせる。
 * ずれると wasm が読めずに落ちるので、vendor を更新したらここも直す。
 */
const ORT = 'onnxruntime-web@1.31.0-dev.20260914-8d85527a0';

const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

/** asyncify付きと無しの両方。どちらが使われるかは端末の判定で変わる。 */
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

const jobs = [
  ...MODEL_FILES.map((f) => [`https://huggingface.co/${MODEL}/resolve/main/${f}`, `hf/${MODEL}/resolve/main/${f}`]),
  ...ORT_FILES.map((f) => [`https://cdn.jsdelivr.net/npm/${ORT}/dist/${f}`, `ort/${f}`]),
];

/**
 * ライブラリ本体も落とす。`+esm` は依存を `/npm/...` の絶対パスで参照しているので、
 * 参照先を辿って同じ場所に並べ直す（そうしないと手元のサーバーから読めない）。
 */
async function mirrorEsm(path, seen = new Set()) {
  if (seen.has(path)) return;
  seen.add(path);
  const res = await fetch(`https://cdn.jsdelivr.net${path}`, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`取得できません (${res.status}): ${path}`);
    process.exit(1);
  }
  const text = await res.text();
  const out = join(ROOT, 'cdn', path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text);
  console.log(`${(text.length / 1e6).toFixed(2)}MB  cdn${path}`);
  for (const m of text.matchAll(/(?:from|import)"(\/npm\/[^"]+)"/g)) {
    await mirrorEsm(m[1], seen);
  }
}

let total = 0;
for (const [url, path] of jobs) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`取得できません (${res.status}): ${url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = join(ROOT, path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, buf);
  total += buf.length;
  console.log(`${(buf.length / 1e6).toFixed(2)}MB  ${path}`);
}

// 本番が読んでいるURLのパス部分をそのまま辿る
await mirrorEsm(new URL(TRANSFORMERS_URL).pathname);
console.log(`\n合計 ${(total / 1e6).toFixed(1)}MB → ${ROOT}`);
