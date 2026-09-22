/**
 * 文字起こしまわりの、ネット無しで確かめられるところ。
 *
 * ライブラリの読み込み先は実機で一度間違えている。CDNの `dist/transformers.web.js` は
 * `import ... from "onnxruntime-web/webgpu"` という名前だけのimportを含んでいて、
 * ブラウザには解決できず読み込んだ瞬間に落ちた。
 * **関数がexportされていることを調べるだけでは、読み込めるかは分からなかった。**
 *
 * 実際に読み込めるかは `npm run test:transcribe` で確かめる（モデルを一度落とせば
 * 以降はオフラインで走る）。ここではURLの形だけを見張る — `dist/` に戻したら落ちる。
 */
import { MODELS, DEFAULT_MODEL_ID, Transcriber } from '../src/subtitles/transcriber.js';
import { TRANSFORMERS_URL } from '../src/subtitles/library-url.js';
import { MonoAudioReader, TARGET_SAMPLE_RATE } from '../src/subtitles/mono16k.js';
import { AMPLITUDE_BY_SECOND, FIXTURE, buildFixture } from './fixture.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

export async function runTranscribeLibrarySuite() {
  results.length = 0;

  /* --- ライブラリのURL --- */
  check(
    'ライブラリは依存を解決済みの形（+esm）を読む',
    TRANSFORMERS_URL.endsWith('/+esm'),
    TRANSFORMERS_URL,
  );
  check(
    'ブラウザでは読み込めない dist/ を読んでいない',
    !TRANSFORMERS_URL.includes('/dist/'),
    TRANSFORMERS_URL,
  );
  check(
    '版が固定されている（勝手に上がって壊れないように）',
    /@\d+\.\d+\.\d+\//.test(TRANSFORMERS_URL),
    TRANSFORMERS_URL,
  );

  /* --- 選べるモデルの指定が正しいか --- */
  check('モデルは2択で、既定はその中にある',
    MODELS.length === 2 && MODELS.some((m) => m.id === DEFAULT_MODEL_ID),
    MODELS.map((m) => m.id).join(', '));
  check('ワーカーが使える環境だと判定される', Transcriber.available === true);

  /* --- Whisperに渡す音声の取り出し --- */
  await checkAudioReader();

  /* --- WebGPUで落ちたときのやり直し --- */
  await checkWebgpuFallback();

  return results;
}

/**
 * WebGPUで駄目だったら、新しいワーカーでWASMを指定してやり直すこと。
 *
 * 同じワーカーの中で試し直しても無駄なことが実機の前に分かっている
 * （ONNX Runtime はセッション作成を1本のPromiseの鎖で直列化していて、
 * 一度失敗するとあとから積んだ分も同じ失敗を受け継ぐ）。
 * ここでは偽のワーカーで、やり直しが起きること・1回で止まることを確かめる。
 */
async function checkWebgpuFallback() {
  const fakeUrl = new URL('./fake-transcribe-worker.js', import.meta.url);

  const recovered = await new Transcriber(fakeUrl)
    .run({ file: new Blob(['x']), duration: 1, mode: 'webgpu-fails' })
    .catch((err) => ({ error: err?.message ?? String(err) }));
  check(
    'WebGPUで落ちてもWASMでやり直して成功する',
    Array.isArray(recovered) && recovered[0]?.text === 'wasmで成功',
    JSON.stringify(recovered),
  );

  let message = null;
  await new Transcriber(fakeUrl)
    .run({ file: new Blob(['x']), duration: 1, mode: 'always-fails' })
    .catch((err) => { message = err?.message ?? String(err); });
  check('やり直しても駄目なら、ちゃんと失敗として返る', message === 'どうやっても駄目', String(message));
}

/**
 * 区間ごとに16kHzモノラルで取り出せているか。
 * テスト動画は秒ごとに振幅が決まっているので、取り出した波の大きさで
 * 「狙った秒がちゃんと来ているか」まで確かめられる。
 */
async function checkAudioReader() {
  const source = await buildFixture({ video: 'vp9', audio: 'opus' });
  const reader = new MonoAudioReader(source);
  const opened = await reader.open();
  check('音声を開ける', opened === true);
  if (!opened) return;

  try {
    const oneSecond = await reader.read(0, 1);
    check(
      '1秒ぶんが16000サンプルになる',
      Math.abs(oneSecond.length - TARGET_SAMPLE_RATE) <= 80,
      `${oneSecond.length}`,
    );

    // 大きい区間（振幅0.95）・小さい区間（0.03）・無音（0）で見分けがつくか
    const loud = peak(await reader.read(1, 2));
    const quiet = peak(await reader.read(9, 10));
    const silent = peak(await reader.read(11, 12));
    check('大きい区間の振幅が元のまま', Math.abs(loud - AMPLITUDE_BY_SECOND[1]) < 0.06, loud.toFixed(3));
    check('小さい区間の振幅が元のまま', Math.abs(quiet - AMPLITUDE_BY_SECOND[9]) < 0.02, quiet.toFixed(3));
    check('無音区間は無音のまま', silent < 0.01, silent.toFixed(4));
    check(
      '区間ごとに違う音が返る（毎回同じ場所を読んでいない）',
      loud > quiet * 5,
      `${loud.toFixed(3)} / ${quiet.toFixed(3)}`,
    );

    const long = await reader.read(0, 12);
    check(
      '長い区間もまとめて取り出せる',
      Math.abs(long.length - TARGET_SAMPLE_RATE * FIXTURE.durationSec) <= 400,
      `${long.length}`,
    );
  } finally {
    reader.close();
  }
}


function peak(samples) {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > max) max = v;
  }
  return max;
}

/** 本番と同じ type:'module' のワーカーの中でimportしてみる。 */
function importInsideWorker(url) {
  const code = `
    (async () => {
      try {
        const mod = await import(${JSON.stringify(url)});
        postMessage({ ok: true, pipeline: typeof mod.pipeline });
      } catch (err) {
        postMessage({ ok: false, message: String(err?.message ?? err) });
      }
    })();
  `;
  const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const worker = new Worker(blobUrl, { type: 'module' });
  return new Promise((resolve) => {
    const done = (value) => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
      resolve(value);
    };
    worker.onmessage = (e) => done(e.data);
    worker.onerror = (e) => done({ ok: false, message: `ワーカーが起動できない: ${e.message}` });
    setTimeout(() => done({ ok: false, message: '時間内に応答なし' }), 30_000);
  });
}
