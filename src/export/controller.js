/**
 * 書き出しの入口。ワーカーを起こし、進捗を流し、結果の mp4 を返す。
 * ワーカーが作れない環境ではUIスレッドで実行する（遅いが動く）。
 */
import { runExport } from './pipeline.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export class Exporter {
  constructor() {
    this.worker = null;
    this.canceled = false;
    this.running = false;
  }

  /**
   * @param {object} params
   * @param {File} params.file
   * @param {object} params.editList
   * @param {string} params.quality
   * @param {(p: {phase: string, ratio: number, detail?: string}) => void} params.onProgress
   */
  async run({ file, editList, quality, onProgress }) {
    if (this.running) throw new Error('すでに書き出し中です。');
    this.running = true;
    this.canceled = false;
    try {
      return await this.#runInWorker({ file, editList, quality, onProgress });
    } catch (err) {
      if (err?.code === 'NO_WORKER') {
        return await runExport({
          file,
          editList,
          quality,
          onProgress,
          isCanceled: () => this.canceled,
        });
      }
      throw err;
    } finally {
      this.running = false;
      this.#terminate();
    }
  }

  cancel() {
    this.canceled = true;
    this.worker?.postMessage({ type: 'cancel' });
  }

  #runInWorker({ file, editList, quality, onProgress }) {
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
        if (msg.type === 'progress') {
          onProgress(msg);
        } else if (msg.type === 'done') {
          resolve(msg.result);
        } else if (msg.type === 'error') {
          const err = new Error(msg.message);
          if (msg.canceled) err.name = 'ExportCanceled';
          err.workerStack = msg.stack;
          reject(err);
        }
      };

      worker.onerror = (event) => {
        // モジュールワーカーが読めない端末では、読み込み時点でここに来る。
        if (!started) {
          const err = new Error('ワーカーを起動できませんでした');
          err.code = 'NO_WORKER';
          reject(err);
          return;
        }
        reject(new Error(event.message || '書き出し中にエラーが発生しました'));
      };

      worker.postMessage({ type: 'export', file, editList, quality });
    });
  }

  #terminate() {
    this.worker?.terminate();
    this.worker = null;
  }
}
