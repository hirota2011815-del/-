/**
 * 無音の自動カット。
 *
 * ステップ3で作った波形のバケット配列（一定フレームごとのRMS）をそのまま使うので、
 * もう一度デコードし直す必要がない。
 *
 * しきい値を一定時間より長く下回る区間を「間」とみなし、有音区間だけを残す。
 * 語尾が切れないよう、残す区間の前後に少し余白を足してから重なりをまとめる。
 *
 * ここも純粋な計算だけなのでNodeでそのままテストできる。
 */
import { dbToAmplitude } from './dbscale.js';

/** しきい値の選択肢（画面のボタンと対応）。 */
export const SILENCE_THRESHOLDS_DB = [-50, -45, -38];
export const DEFAULT_SILENCE_THRESHOLD_DB = -45;

/** これより短い無音は「間」とみなさない（秒）。 */
export const MIN_SILENCE_SEC = 0.6;
/** 有音区間の前後に残す余白（秒）。 */
export const PAD_SEC = 0.12;

/**
 * 有音区間を検出する。
 *
 * @param {{rms: Float32Array, sampleRate: number, bucketFrames: number}} waveform
 * @param {object} options
 * @param {number} options.duration 動画全体の長さ（秒）
 * @param {number} [options.thresholdDb]
 * @param {number} [options.minSilenceSec]
 * @param {number} [options.padSec]
 * @param {number} [options.minRangeSec] これより短い有音区間は捨てる
 * @returns {{in: number, out: number}[]} 時間順に並んだ有音区間
 */
export function detectSoundedRanges(waveform, {
  duration,
  thresholdDb = DEFAULT_SILENCE_THRESHOLD_DB,
  minSilenceSec = MIN_SILENCE_SEC,
  padSec = PAD_SEC,
  minRangeSec = 0.1,
}) {
  const { rms, sampleRate, bucketFrames } = waveform;
  if (!rms || rms.length === 0) return [];

  const bucketDuration = bucketFrames / sampleRate;
  const threshold = dbToAmplitude(thresholdDb);
  const minSilenceBuckets = Math.max(1, Math.round(minSilenceSec / bucketDuration));

  // 1. しきい値を下回り続けるバケットの並び（＝無音の候補）を拾う
  const silences = [];
  let runStart = -1;
  for (let i = 0; i < rms.length; i += 1) {
    const isSilent = rms[i] < threshold;
    if (isSilent && runStart === -1) {
      runStart = i;
    } else if (!isSilent && runStart !== -1) {
      if (i - runStart >= minSilenceBuckets) silences.push([runStart, i]);
      runStart = -1;
    }
  }
  if (runStart !== -1 && rms.length - runStart >= minSilenceBuckets) {
    silences.push([runStart, rms.length]);
  }

  // 2. 無音の隙間 = 有音区間
  const sounded = [];
  let cursor = 0;
  for (const [start, end] of silences) {
    if (start > cursor) sounded.push([cursor, start]);
    cursor = end;
  }
  if (cursor < rms.length) sounded.push([cursor, rms.length]);

  // 3. 秒に直し、前後に余白を足し、重なったらまとめる
  const ranges = [];
  for (const [startBucket, endBucket] of sounded) {
    const start = Math.max(0, startBucket * bucketDuration - padSec);
    const end = Math.min(duration, endBucket * bucketDuration + padSec);
    if (end - start < minRangeSec) continue;

    const last = ranges.at(-1);
    if (last && start <= last.out) {
      last.out = Math.max(last.out, end);
    } else {
      ranges.push({ in: start, out: end });
    }
  }
  return ranges;
}

/**
 * 無音カットの結果を、人に見せる一言にする。
 * @param {{in: number, out: number}[]} ranges
 * @param {number} duration
 */
export function describeSilenceCut(ranges, duration) {
  if (ranges.length === 0) return '音が見つかりませんでした。しきい値を下げて試してください。';
  const kept = ranges.reduce((sum, r) => sum + (r.out - r.in), 0);
  const removed = Math.max(0, duration - kept);
  if (removed < 0.05) return '外せる「間」は見つかりませんでした。';
  if (ranges.length === 1) return `${removed.toFixed(1)}秒ぶんの「間」を外しました。`;
  return `${ranges.length}個のクリップに分け、${removed.toFixed(1)}秒ぶんの「間」を外しました。`;
}
