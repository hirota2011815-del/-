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
import { TRANSFORMERS_URL } from './library-url.js';
import { MonoAudioReader, TARGET_SAMPLE_RATE } from './mono16k.js';
import { dropQuietSegments, toSegments } from './transcript.js';
import { planWindows } from './windows.js';



/**
 * 8bitに量子化したモデル。tinyで約41MB、baseで約77MB。
 * WebGPUでもWASMでも同じファイルを使う。WebGPU向けにfp32やq4を選ぶと速くはなるが、
 * 別のファイルを落とすことになり、WebGPUが駄目だったときに回線を2度使わせてしまう。
 */
const DTYPE = 'q8';

/**
 * どちらで走らせるかを **先に決める**。1回のワーカーで試すのは1つだけ。
 *
 * ここを「WebGPUで試して駄目ならWASM」という作りにしてはいけない。
 * ONNX Runtime は推論セッションの作成を1本のPromiseの鎖に並べて直列化しており
 * （`chain = chain.then(create)`）、一度その鎖が失敗すると、あとから積んだ分も
 * 同じ失敗を受け継いで実行されない。つまり同じワーカーの中では、WebGPUが落ちた
 * 時点でWASMも必ず落ちる（しかも報告されるのはWebGPU側のエラー文言）。
 *
 * そこで、**失敗するセッションを作らない**ようにする。
 * GPUが実際に取れるかを先に確かめ、取れたときだけWebGPUを選ぶ。
 * それでも駄目だった場合は、呼び出し側が新しいワーカーでWASMを指定してやり直す
 * （ワーカーを作り直せば鎖も作り直される）。
 */
async function pickDevice(forceDevice) {
  if (forceDevice) return forceDevice;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return 'webgpu';
  } catch {
    /* WebGPUが無い・使えない端末。WASMで走らせる。 */
  }
  return 'wasm';
}

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
      device: err?.device ?? null,
    });
  }
};

async function transcribe({ file, duration, waveform, model, language, endpoints, forceDevice }) {
  const post = (payload) => self.postMessage(payload);
  const checkCanceled = () => {
    if (canceled) {
      const err = new Error('文字起こしを中止しました');
      err.name = 'TranscribeCanceled';
      throw err;
    }
  };

  const asr = await loadModel({ model, post, checkCanceled, endpoints, forceDevice });
  checkCanceled();

  const reader = new MonoAudioReader(file);
  if (!(await reader.open())) throw new Error('この動画には読み取れる音声がありません。');

  try {
    const windows = planWindows({ duration, waveform });
    const all = [];
    // 何分かかるか読めないと待つのがつらいので、終わった区間の実測から残りを見積もる
    const startedAt = Date.now();

    for (let i = 0; i < windows.length; i += 1) {
      checkCanceled();
      const w = windows[i];
      post({
        type: 'progress',
        phase: 'transcribe',
        ratio: i / windows.length,
        detail: `${i + 1}/${windows.length} 区間目${remainingHint(startedAt, i, windows.length)}`,
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

      // 声が入っていない時間に出たもの（幻聴）はここで落とす
      const kept = dropQuietSegments(toSegments(result, w), audio, w.start, TARGET_SAMPLE_RATE);
      for (const seg of kept) all.push(seg);
      post({ type: 'segments', segments: all.slice() });
    }

    post({ type: 'progress', phase: 'transcribe', ratio: 1, detail: '仕上げています' });
    return all;
  } finally {
    reader.close();
  }
}

/** モデルを読む（初回だけダウンロードが走る）。 */
async function loadModel({ model, post, checkCanceled, endpoints, forceDevice }) {
  if (loaded?.key === model) return loaded.asr;

  post({ type: 'progress', phase: 'model', ratio: 0, detail: '文字起こしの準備をしています' });

  let pipeline;
  let env;
  try {
    // テストのときだけ手元のコピーへ向ける（ネットに出ずに確かめられるように）
    ({ pipeline, env } = await import(/* @vite-ignore */ endpoints?.libraryUrl ?? TRANSFORMERS_URL));
  } catch (err) {
    throw new Error(
      `文字起こしの部品を読み込めませんでした（${err?.message ?? err}）。`
      + 'ネットにつながっているか確認してください。',
    );
  }
  // 自分のサーバーにモデルを置いていないので、ローカル探索は切る（404が出るだけのため）
  env.allowLocalModels = false;
  /*
   * モデルとWASMの取得先。既定のまま（Hugging Face と jsDelivr）で使う。
   * テストのときだけ、ネットに出ずに済むよう手元のコピーへ向ける
   * （書き出しの `codecs` と同じ、差し替え用の一点）。
   */
  if (endpoints?.remoteHost) env.remoteHost = endpoints.remoteHost;
  if (endpoints?.wasmPaths) env.backends.onnx.wasm.wasmPaths = endpoints.wasmPaths;
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

  const device = await pickDevice(forceDevice);
  checkCanceled();

  try {
    const asr = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype: DTYPE,
      progress_callback: progressCallback,
    });
    loaded = { key: model, asr, backend: device };
    post({ type: 'backend', label: device });
    return asr;
  } catch (err) {
    const failure = new Error(`文字起こしの準備に失敗しました（${device}: ${err?.message ?? err}）`);
    // 呼び出し側が「WASMでやり直す価値があるか」を判断できるようにしておく
    failure.device = device;
    throw failure;
  }
}

/**
 * 「あと何分」の見積もり。1区間でも終わっていないと出せないので、最初は空。
 * 端末の速さも動画の中身も事前には分からないため、実測の平均から出す。
 */
function remainingHint(startedAt, done, total) {
  if (done === 0) return '';
  const perWindowMs = (Date.now() - startedAt) / done;
  const remainingSec = Math.round((perWindowMs * (total - done)) / 1000);
  if (remainingSec < 60) return ` · 残り約${remainingSec}秒`;
  return ` · 残り約${Math.ceil(remainingSec / 60)}分`;
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
