/**
 * 音声のピーク/RMS解析。
 *
 * 長尺でも全体をメモリに載せないよう、一定フレーム数ごとの
 * ピーク（絶対値の最大）とRMS（二乗平均平方根）だけを配列に残す。
 * ズームレベルが変わっても、この配列を集約し直すだけで描画できる
 * （src/audio/dbscale.js の aggregateRange）。
 *
 * Web Workerとメインスレッドどちらからでもimportできるよう、
 * DOM要素には触れずBlob/Fileだけを受け取る。
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from '../../vendor/mediabunny.min.mjs';

/** 1バケットあたりのフレーム数。48kHzで約21ms、画面のピクセル解像度より十分細かい。 */
export const BUCKET_FRAMES = 1024;

/** この個数のバケットが貯まるたびに、進捗と新規ぶんのデータを報告する。 */
const REPORT_EVERY_BUCKETS = 256;

export class WaveformCanceled extends Error {
  constructor() {
    super('波形解析を中止しました');
    this.name = 'WaveformCanceled';
  }
}

/**
 * @param {Blob} file
 * @param {(chunk: {ratio: number, peaksSlice: Float32Array, rmsSlice: Float32Array}) => void} onChunk
 *   新しく確定したぶんのバケットだけを、その都度渡す（コピー、転送済みでない小さな配列）。
 * @param {() => boolean} [isCanceled]
 * @returns {Promise<{peaks: Float32Array, rms: Float32Array, sampleRate: number,
 *   bucketFrames: number, channels: number, duration: number} | null>}
 *   音声トラックが無い／読めない場合は null。
 */
export async function analyzeWaveform(file, onChunk, isCanceled = () => false) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;

    const sampleRate = await track.getSampleRate();
    const channels = await track.getNumberOfChannels();
    const duration = await input.computeDuration();
    const totalBuckets = Math.max(1, Math.ceil((duration * sampleRate) / BUCKET_FRAMES));

    const peaks = new Float32Array(totalBuckets);
    const rms = new Float32Array(totalBuckets);
    let bucketIndex = 0;
    let lastReportedIndex = 0;

    let pendingFrames = 0;
    let pendingPeak = 0;
    let pendingSumSquares = 0;

    const flushBucket = () => {
      if (bucketIndex >= totalBuckets) {
        // 長さの見積もりよりわずかに多くデコードされた場合は切り捨てる。
        pendingFrames = 0;
        pendingPeak = 0;
        pendingSumSquares = 0;
        return;
      }
      peaks[bucketIndex] = pendingPeak;
      rms[bucketIndex] = pendingFrames > 0 ? Math.sqrt(pendingSumSquares / pendingFrames) : 0;
      bucketIndex += 1;
      pendingFrames = 0;
      pendingPeak = 0;
      pendingSumSquares = 0;
    };

    const report = (final) => {
      if (!final && bucketIndex - lastReportedIndex < REPORT_EVERY_BUCKETS) return;
      onChunk({
        ratio: bucketIndex / totalBuckets,
        peaksSlice: peaks.slice(lastReportedIndex, bucketIndex),
        rmsSlice: rms.slice(lastReportedIndex, bucketIndex),
        // 定数だが、呼び出し側が最初のチャンクからすぐ描画できるよう毎回含める。
        sampleRate,
        bucketFrames: BUCKET_FRAMES,
      });
      lastReportedIndex = bucketIndex;
    };

    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(0, duration)) {
      if (isCanceled()) {
        sample.close();
        throw new WaveformCanceled();
      }
      try {
        const frames = sample.numberOfFrames;
        const planes = [];
        for (let ch = 0; ch < channels; ch += 1) {
          const plane = new Float32Array(frames);
          sample.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
          planes.push(plane);
        }
        for (let i = 0; i < frames; i += 1) {
          let frameAbsMax = 0;
          let framePower = 0;
          for (let ch = 0; ch < channels; ch += 1) {
            const v = planes[ch][i];
            const abs = v < 0 ? -v : v;
            if (abs > frameAbsMax) frameAbsMax = abs;
            framePower += v * v;
          }
          if (frameAbsMax > pendingPeak) pendingPeak = frameAbsMax;
          pendingSumSquares += framePower / channels; // チャンネル平均パワー
          pendingFrames += 1;
          if (pendingFrames >= BUCKET_FRAMES) flushBucket();
        }
      } finally {
        sample.close();
      }
      report(false);
    }
    if (pendingFrames > 0) flushBucket();
    report(true);

    return {
      peaks: peaks.subarray(0, bucketIndex),
      rms: rms.subarray(0, bucketIndex),
      sampleRate,
      bucketFrames: BUCKET_FRAMES,
      channels,
      duration,
    };
  } finally {
    input.dispose();
  }
}

/**
 * 音声トラックのチャンネル数だけを軽く覗き見る（メーターの表示本数を決めるため）。
 * ヘッダ情報だけ読むので、ファイル全体のデコードは発生しない。
 * @returns {Promise<number>} トラックが無ければ 0。
 */
export async function getAudioChannelCount(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return 0;
    return await track.getNumberOfChannels();
  } finally {
    input.dispose();
  }
}

/** Float32Arrayを2つ連結する（波形チャンクの逐次結合に使う）。 */
export function concatFloat32(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
