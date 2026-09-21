/**
 * 文字起こしに渡す音声を作る。
 *
 * Whisper が受け取れるのは「16kHz・モノラル・-1〜1のfloat」だけなので、
 * 元動画の音声をその形に直す。区間ごとに取り出すので、30分の動画でも
 * メモリに載るのは常に30秒ぶん（16kHz × 30秒 × 4バイト ≒ 2MB）で済む。
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from '../../vendor/mediabunny.min.mjs';

/** Whisperが前提にしているサンプルレート。 */
export const TARGET_SAMPLE_RATE = 16000;

/**
 * モノラルの音声を線形補間でリサンプルする。
 *
 * 声の書き起こしが目的なので、折り返し歪みを厳密に抑えるフィルターは入れない
 * （Whisperは元々ノイズに強く、ここに手間をかけても認識精度は上がらない）。
 *
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleMonoLinear(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) return input;

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx];
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** チャンネルを足して平均を取る（モノラル化）。 */
export function downmixToMono(planes, frames) {
  if (planes.length === 1) return planes[0];
  const out = new Float32Array(frames);
  for (let ch = 0; ch < planes.length; ch += 1) {
    const plane = planes[ch];
    for (let i = 0; i < frames; i += 1) out[i] += plane[i];
  }
  const scale = 1 / planes.length;
  for (let i = 0; i < frames; i += 1) out[i] *= scale;
  return out;
}

/**
 * 動画の音声を、区間ごとに 16kHz モノラルで取り出す入れ物。
 *
 * 区間ごとにファイルを開き直すと毎回ヘッダを読み直すことになるので、
 * 1回開いたものを使い回す。使い終わったら close() を呼ぶこと。
 */
export class MonoAudioReader {
  #input = null;
  #sink = null;
  #sampleRate = 0;
  #channels = 0;

  /** @param {Blob} file */
  constructor(file) {
    this.file = file;
  }

  /** @returns {Promise<boolean>} 読める音声トラックがあれば true。 */
  async open() {
    this.#input = new Input({ source: new BlobSource(this.file), formats: ALL_FORMATS });
    const track = await this.#input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      this.close();
      return false;
    }
    this.#sampleRate = await track.getSampleRate();
    this.#channels = await track.getNumberOfChannels();
    this.#sink = new AudioSampleSink(track);
    return true;
  }

  /**
   * [start, end) を 16kHz モノラルで取り出す。
   * @returns {Promise<Float32Array>}
   */
  async read(start, end) {
    if (!this.#sink) throw new Error('音声を開いていません。');

    const wanted = Math.max(0, Math.round((end - start) * this.#sampleRate));
    const buffer = new Float32Array(wanted);
    let written = 0;

    for await (const sample of this.#sink.samples(start, end)) {
      try {
        const frames = sample.numberOfFrames;
        const planes = [];
        for (let ch = 0; ch < this.#channels; ch += 1) {
          const plane = new Float32Array(frames);
          sample.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
          planes.push(plane);
        }
        const mono = downmixToMono(planes, frames);

        // samples() は start をまたぐサンプルから返すので、区間の頭ではみ出しを切る
        const offset = Math.round((sample.timestamp - start) * this.#sampleRate);
        const from = Math.max(0, -offset);
        const to = Math.min(frames, wanted - offset);
        for (let i = from; i < to; i += 1) buffer[offset + i] = mono[i];
        written = Math.max(written, Math.min(wanted, offset + to));
      } finally {
        sample.close();
      }
    }

    return resampleMonoLinear(buffer.subarray(0, written), this.#sampleRate, TARGET_SAMPLE_RATE);
  }

  close() {
    try {
      this.#input?.dispose();
    } catch {
      /* 後片付けの失敗は無視してよい */
    }
    this.#input = null;
    this.#sink = null;
  }
}
