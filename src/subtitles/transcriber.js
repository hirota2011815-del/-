/**
 * 文字起こしの入口。ワーカーを起こし、進捗と途中結果を流す。
 *
 * 波形解析や書き出しと違い、ここにはメインスレッドで動かす逃げ道を用意しない。
 * Whisperは1区間に数秒〜数十秒かかるので、UIスレッドで回すと画面が固まって
 * 中止すら押せなくなる。ワーカーが作れない端末では機能ごと出さない。
 */

const WORKER_URL = new URL('./transcribe-worker.js', import.meta.url);

/** 選べるモデル。大きいほど賢いが、ダウンロードも処理も重くなる。 */
export const MODELS = [
  {
    id: 'onnx-community/whisper-tiny',
    label: '速い',
    note: '約41MB・聞き取りは粗め',
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'ふつう',
    note: '約77MB・おすすめ',
  },
];

export const DEFAULT_MODEL_ID = 'onnx-community/whisper-base';

/** 日本語で固定する。区間ごとに言語を推測させると、短い区間で判定が揺れるため。 */
export const DEFAULT_LANGUAGE = 'ja';

export class Transcriber {
  /** @param {URL|string} [workerUrl] テストから差し替えるためだけの引数。 */
  constructor(workerUrl = WORKER_URL) {
    this.workerUrl = workerUrl;
    this.worker = null;
    this.running = false;
    /** @type {string|null} 実際に使われた実行方法（WebGPU / WASM）。 */
    this.backend = null;
    /** 中止したときに、待っている呼び出し元を起こすために持っておく。 */
    this.rejectPending = null;
  }

  static get available() {
    return typeof Worker !== 'undefined';
  }

  /**
   * @param {object} p
   * @param {Blob} p.file
   * @param {number} p.duration
   * @param {{rms: Float32Array, sampleRate: number, bucketFrames: number} | null} [p.waveform]
   *   区切りを静かなところに寄せるために使う。無くても動く。
   * @param {string} [p.model]
   * @param {(p: {phase: string, ratio: number, detail?: string}) => void} [p.onProgress]
   * @param {(segments: {start:number,end:number,text:string}[]) => void} [p.onPartial]
   *   区間が1つ終わるたびに、そこまでの結果を渡す（待っている間も画面に出せるように）。
   * @returns {Promise<{start:number,end:number,text:string}[]>}
   */
  run({
    file,
    duration,
    waveform = null,
    model = DEFAULT_MODEL_ID,
    language = DEFAULT_LANGUAGE,
    onProgress = () => {},
    onPartial = () => {},
  }) {
    if (this.running) return Promise.reject(new Error('すでに文字起こし中です。'));

    let worker;
    try {
      worker = new Worker(this.workerUrl, { type: 'module' });
    } catch {
      return Promise.reject(new Error('この端末では文字起こしを実行できません。'));
    }
    this.worker = worker;
    this.running = true;

    return new Promise((resolve, reject) => {
      this.rejectPending = reject;
      worker.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === 'progress') {
          onProgress(msg);
        } else if (msg.type === 'backend') {
          this.backend = msg.label;
        } else if (msg.type === 'segments') {
          onPartial(msg.segments);
        } else if (msg.type === 'done') {
          resolve(msg.segments);
        } else if (msg.type === 'error') {
          const err = new Error(msg.message);
          if (msg.canceled) err.name = 'TranscribeCanceled';
          reject(err);
        }
      };
      worker.onerror = (event) => {
        reject(new Error(event.message || '文字起こし中にエラーが発生しました'));
      };

      // 波形は転送せずコピーで渡す（呼び出し元はこのあとも描画に使うため）
      worker.postMessage({
        type: 'transcribe',
        file,
        duration,
        waveform: waveform
          ? { rms: waveform.rms, sampleRate: waveform.sampleRate, bucketFrames: waveform.bucketFrames }
          : null,
        model,
        language,
      });
    }).finally(() => {
      this.rejectPending = null;
      this.running = false;
      this.#terminate();
    });
  }

  cancel() {
    if (!this.running) return;
    /*
     * 推論の最中、ワーカーは届いたメッセージを見に来ない（1区間ぶんの計算が
     * 終わるまでイベントループに戻らない）。中止フラグだけでは止まらないので
     * ワーカーごと終了させる。
     * すると done も error も返ってこないため、待っている呼び出し元は
     * ここから起こしてやる必要がある。
     */
    const err = new Error('文字起こしを中止しました');
    err.name = 'TranscribeCanceled';
    this.rejectPending?.(err);
    this.#terminate();
    this.running = false;
  }

  #terminate() {
    try {
      this.worker?.terminate();
    } catch {
      /* すでに落ちていても構わない */
    }
    this.worker = null;
  }
}
