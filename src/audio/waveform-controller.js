/**
 * 波形解析の入口。ワーカーを起こし、確定したぶんのバケットを都度受け取って
 * 呼び出し元に流す。ワーカーが使えない環境ではメインスレッドで実行する。
 *
 * 新しいファイルを開いたときに前の解析を打ち切れるよう、明示的にcancelを持つ。
 */
import { analyzeWaveform } from './waveform.js';

const WORKER_URL = new URL('./waveform-worker.js', import.meta.url);

export class WaveformAnalyzer {
  constructor() {
    this.worker = null;
    this.canceled = false;
    this.running = false;
  }

  /**
   * @param {object} params
   * @param {File} params.file
   * @param {(chunk: {ratio: number, peaksSlice: Float32Array, rmsSlice: Float32Array}) => void} params.onChunk
   * @returns {Promise<{sampleRate:number, bucketFrames:number, channels:number, duration:number}|null>}
   *   音声トラックが無ければ null。
   */
  async run({ file, onChunk }) {
    this.cancel(); // 前の解析が残っていたら打ち切る
    this.canceled = false;
    this.running = true;
    try {
      return await this.#runInWorker({ file, onChunk });
    } catch (err) {
      if (err?.code === 'NO_WORKER') {
        return await analyzeWaveform(file, onChunk, () => this.canceled);
      }
      throw err;
    } finally {
      this.running = false;
    }
  }

  cancel() {
    this.canceled = true;
    this.worker?.postMessage({ type: 'cancel' });
    this.worker?.terminate();
    this.worker = null;
  }

  #runInWorker({ file, onChunk }) {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch {
      const err = new Error('ワーカーを起動できませんでした');
      err.code = 'NO_WORKER';
      throw err;
    }
    this.worker = worker;

    return new Promise((resolve, reject) => {
      let started = false;
      worker.onmessage = (event) => {
        const msg = event.data;
        started = true;
        if (msg.type === 'chunk') {
          onChunk({
            ratio: msg.ratio,
            peaksSlice: msg.peaksSlice,
            rmsSlice: msg.rmsSlice,
            sampleRate: msg.sampleRate,
            bucketFrames: msg.bucketFrames,
          });
        } else if (msg.type === 'done') {
          resolve(msg.empty ? null : msg);
        } else if (msg.type === 'canceled') {
          resolve(null);
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (event) => {
        if (!started) {
          const err = new Error('ワーカーを起動できませんでした');
          err.code = 'NO_WORKER';
          reject(err);
          return;
        }
        reject(new Error(event.message || '波形解析中にエラーが発生しました'));
      };
      worker.postMessage({ type: 'analyze', file });
    });
  }
}
