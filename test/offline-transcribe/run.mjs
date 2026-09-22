/**
 * 文字起こしを、本番のコードのまま最後まで走らせる（ネット不要）。
 *
 *   node test/offline-transcribe/fetch.mjs   # 先に一度だけ
 *   node test/offline-transcribe/run.mjs
 *
 * ## なぜ別立てなのか
 * モデルが83MBあるのでCIには入れられない。だがここでしか見つからない不具合がある。
 * 実際にこの検証で2件見つかっている:
 *
 *  1. CDNの `dist/transformers.web.js` は名前だけのimportを含んでいて、
 *     ブラウザでは読み込んだ瞬間に落ちる。**関数がexportされているかを調べるだけでは
 *     分からなかった。** → 依存を解決済みのものを vendor/ に同梱して解決。
 *  2. 「WebGPUで試して駄目ならWASM」という作りが、同じワーカーの中では必ず失敗する。
 *     ONNX Runtime がセッション作成を1本のPromiseの鎖で直列化していて、一度失敗すると
 *     あとから積んだ分も同じ失敗を受け継ぐため。 → 先にGPUが取れるか確かめて
 *     1つだけ試す／やり直すときはワーカーごと作り直す、に変更して解決。
 *
 * 読み上げの音声は用意できないので、出てくる文字は意味を成さない。
 * ここで見るのは「最後まで通るか」「返ってくる形が想定どおりか」。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSFORMERS_URL } from '../../src/subtitles/library-url.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIRROR = resolve(HERE, 'mirror');
const APP = resolve(HERE, '..', '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

try {
  await access(join(MIRROR, 'ort'));
} catch {
  console.error('先に `node test/offline-transcribe/fetch.mjs` を実行してください。');
  process.exit(1);
}

const TYPES = {
  '.json': 'application/json', '.wasm': 'application/wasm', '.mjs': 'text/javascript',
  '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
};

const server = createServer(async (req, res) => {
  const path = normalize(decodeURI(req.url.split('?')[0]));
  // /hf/ と /ort/ は落としてきたコピー、それ以外はアプリ本体
  // /hf/ /ort/ /npm/ は落としてきたコピー、それ以外はアプリ本体
  const isCdn = path.startsWith('/npm/');
  const mirrored = isCdn || path.startsWith('/hf/') || path.startsWith('/ort/');
  try {
    const body = await readFile(mirrored ? join(MIRROR, isCdn ? 'cdn' : '', path) : join(APP, path));
    // jsDelivr の `+esm` には拡張子が無い。JSとして返さないとブラウザが実行しない。
    const type = isCdn ? 'text/javascript' : TYPES[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
let failed = 0;

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
  await page.goto(`http://localhost:${port}/test/harness.html`);

  const out = await page.evaluate(async ({ p, LIB }) => {
    const { Transcriber } = await import('/src/subtitles/transcriber.js');
    const { buildFixture } = await import('/test/fixture.js');
    const file = await buildFixture({ video: 'vp9', audio: 'opus' });

    const phases = new Set();
    const partials = [];
    const startedAt = performance.now();
    try {
      const segments = await new Transcriber().run({
        file,
        duration: 12,
        model: 'onnx-community/whisper-tiny',
        onProgress: (x) => phases.add(x.phase),
        onPartial: (s) => partials.push(s.length),
        endpoints: {
          libraryUrl: `http://localhost:${p}${new URL(LIB).pathname}`,
          remoteHost: `http://localhost:${p}/hf/`,
          wasmPaths: {
            mjs: `http://localhost:${p}/ort/ort-wasm-simd-threaded.mjs`,
            wasm: `http://localhost:${p}/ort/ort-wasm-simd-threaded.wasm`,
          },
        },
      });
      return { ok: true, ms: Math.round(performance.now() - startedAt), segments, partials, phases: [...phases] };
    } catch (err) {
      return { ok: false, message: String(err?.message ?? err) };
    }
  }, { p: port, LIB: TRANSFORMERS_URL });

  const checks = [
    ['ライブラリが読み込めて最後まで走る', out.ok === true, out.message ?? ''],
    ['字幕の素が返る', Array.isArray(out.segments) && out.segments.length > 0, JSON.stringify(out.segments)],
    ['時刻が数値で入っている',
      out.segments?.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)],
    ['文字が入っている', out.segments?.every((s) => typeof s.text === 'string' && s.text.length > 0)],
    ['準備と聞き取りの両方で進捗が出る',
      out.phases?.includes('model') && out.phases?.includes('transcribe'), (out.phases ?? []).join(',')],
    ['途中経過が届く', out.partials?.length > 0, `${out.partials?.length}回`],
  ];

  console.log('\n文字起こし（手元のモデルで最後まで）');
  for (const [name, pass, detail] of checks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!pass) failed += 1;
  }
  if (out.ok) console.log(`\n  12秒の動画で ${(out.ms / 1000).toFixed(1)}秒（このPCのWASM・tiny）`);
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\n通りました。' : `\n${failed} 件失敗しました。`);
process.exit(failed === 0 ? 0 : 1);
