/**
 * 文字起こしワーカー。
 *
 * Whisper を端末の中で走らせて、字幕の下書きを作る。音声はどこにも送らない。
 *
 * ## ネットにつながるのはここだけ
 * このアプリで唯一、外から物を取ってくるのがこの処理。Whisperのモデルを
 * Hugging Face から一度だけダウンロードする（以降はブラウザのキャッシュから読む）。
 * ダウンロードするのはモデルだけで、動画も音声も一切アップロードしない。
 *
 * ## 長い動画への対処
 * Whisperは一度に30秒ぶんしか見られない。ライブラリ側にも分割機能があるが、
 * それを使うには音声を丸ごと1本のFloat32Arrayに載せる必要があり、30分の動画だと
 * 100MBを超える。そこでこちらで区間に切り、1区間ずつ読んでは渡す。
 * 常にメモリに載るのは30秒ぶん（約2MB）だけで、区間ごとに進捗も出せる。
 */
import { MonoAudioReader } from './mono16k.js';
import { toSegments } from './transcript.js';
import { planWindows } from './windows.js';

/**
 * ライブラリの読み込み元。バージョンは固定する
 * （勝手に上がって動かなくなるのを防ぐため）。
 */
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.web.js';

/**
 * 試す実行方法を上から順に。WebGPUが使えれば数倍速いが、端末やOSのバージョンに
 * よっては初期化で落ちるので、必ずWASMへ落とせるようにする。
 *
 * どちらも同じ q8（8bit量子化）のファイルを使う。WebGPU向けにfp32やq4を選ぶと
 * 速くはなるが別のファイルを落とすことになり、WebGPUの初期化に失敗したときに
 * WASM用をもう一度ダウンロードする羽目になる。回線を2度使わせないほうを採った。
 */
const BACKENDS = [
  { device: 'webgpu', label: 'WebGPU' },
  { device: 'wasm', label: 'WASM' },
];

/** 8bitに量子化したモデル。tinyで約41MB、baseで約77MB。 */
const DTYPE = 'q8';

let canceled = false;
/** @type {{key: string, asr: Function, backend: string} | null} モデルは読み直さず使い回す。 */
let loaded = null;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    canceled = true;
    return;
  }
  if (msg.type !== 'transcribe') return;
  canceled = false;

  try {
    const segments = await transcribe(msg);
    self.postMessage({ type: 'done', segments });
  } catch (err) {
    self.postMessage({
      type: 'error',
      canceled: canceled || err?.name === 'TranscribeCanceled',
      message: err?.message ?? String(err),
    });
  }
};

async function transcribe({ file, duration, waveform, model, language }) {
  const post = (payload) => self.postMessage(payload);
  const checkCanceled = () => {
    if (canceled) {
      const err = new Error('文字起こしを中止しました');
      err.name = 'TranscribeCanceled';
      throw err;
    }
  };

  const asr = await loadModel({ model, post, checkCanceled });
  checkCanceled();

  const reader = new MonoAudioReader(file);
  if (!(await reader.open())) throw new Error('この動画には読み取れる音声がありません。');

  try {
    const windows = planWindows({ duration, waveform });
    const all = [];

    for (let i = 0; i < windows.length; i += 1) {
      checkCanceled();
      const w = windows[i];
      post({
        type: 'progress',
        phase: 'transcribe',
        ratio: i / windows.length,
        detail: `${i + 1}/${windows.length} 区間目`,
      });

      const audio = await reader.read(w.start, w.end);
      checkCanceled();
      // 無音だけの区間にモデルを走らせると、ありもしない言葉を返すことがある
      if (isSilent(audio)) continue;

      const result = await asr(audio, {
        return_timestamps: true,
        // 区間ごとに別々に判定させると言語が揺れるので、明示して固定する
        language,
        task: 'transcribe',
      });

      for (const seg of toSegments(result, w)) all.push(seg);
      post({ type: 'segments', segments: all.slice() });
    }

    post({ type: 'progress', phase: 'transcribe', ratio: 1, detail: '仕上げています' });
    return all;
  } finally {
    reader.close();
  }
}

/** モデルを読む（初回だけダウンロードが走る）。 */
async function loadModel({ model, post, checkCanceled }) {
  if (loaded?.key === model) return loaded.asr;

  post({ type: 'progress', phase: 'model', ratio: 0, detail: '文字起こしの準備をしています' });

  const { pipeline, env } = await import(/* @vite-ignore */ TRANSFORMERS_URL);
  // 自分のサーバーにモデルを置いていないので、ローカル探索は切る（404が出るだけのため）
  env.allowLocalModels = false;
  checkCanceled();

  const progressCallback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    post({
      type: 'progress',
      phase: 'model',
      ratio: p.loaded / p.total,
      detail: `文字起こしの準備 ${Math.round((p.loaded / p.total) * 100)}%`,
    });
  };

  let lastError = null;
  for (const backend of BACKENDS) {
    try {
      const asr = await pipeline('automatic-speech-recognition', model, {
        device: backend.device,
        dtype: DTYPE,
        progress_callback: progressCallback,
      });
      loaded = { key: model, asr, backend: backend.label };
      post({ type: 'backend', label: backend.label });
      return asr;
    } catch (err) {
      lastError = err;
      checkCanceled();
    }
  }
  throw new Error(`文字起こしの準備に失敗しました（${lastError?.message ?? '不明なエラー'}）`);
}

/** 全部が無音に近いか。しきい値は無音カットより低め（消え入る声を捨てないため）。 */
function isSilent(audio) {
  let peak = 0;
  for (let i = 0; i < audio.length; i += 1) {
    const v = audio[i] < 0 ? -audio[i] : audio[i];
    if (v > peak) peak = v;
  }
  return peak < 0.002; // 約 -54dB
}
