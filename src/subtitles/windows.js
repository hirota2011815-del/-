/**
 * 文字起こしを分割する区切りを決める。
 *
 * Whisper は一度に30秒ぶんしか見られないので、長い動画は分けて渡すしかない。
 * ところが機械的に30秒で切ると、言葉の途中で切れて「こんに」「ちは」のように
 * 崩れる。そこで **区切りの候補あたりで一番静かなところ** を探して、そこで切る。
 *
 * 静けさは、タイムラインの波形（RMSバケット）をそのまま使う。
 * 文字起こしのために音声をもう一度デコードし直す必要はない。
 * 波形がまだ無いときは等間隔で切る（言葉が割れることがある）。
 */

/** 1区間の目安の長さ（秒）。 */
export const WINDOW_TARGET_SEC = 24;

/** 1区間の上限（秒）。Whisperが一度に見られる30秒を超えない。 */
export const WINDOW_MAX_SEC = 29;

/** 区切りの候補をこの秒数だけ前後に探して、一番静かなところを選ぶ。 */
export const WINDOW_SEARCH_SEC = 4;

/**
 * @param {object} p
 * @param {number} p.duration 元動画の長さ（秒）
 * @param {{rms: Float32Array, sampleRate: number, bucketFrames: number} | null} [p.waveform]
 * @returns {{start: number, end: number}[]}
 */
export function planWindows({
  duration,
  waveform = null,
  targetSec = WINDOW_TARGET_SEC,
  maxSec = WINDOW_MAX_SEC,
  searchSec = WINDOW_SEARCH_SEC,
}) {
  if (!(duration > 0)) return [];
  if (duration <= maxSec) return [{ start: 0, end: duration }];

  const windows = [];
  let cursor = 0;

  while (cursor < duration) {
    // 残りが上限に収まるなら、そこで終わり（半端な最後の区間を作らない）
    if (duration - cursor <= maxSec) {
      windows.push({ start: cursor, end: duration });
      break;
    }

    const target = cursor + targetSec;
    const lo = Math.max(cursor + 1, target - searchSec);
    const hi = Math.min(duration, cursor + maxSec, target + searchSec);
    const boundary = quietestTime(waveform, lo, hi) ?? target;

    windows.push({ start: cursor, end: boundary });
    cursor = boundary;
  }

  return windows;
}

/**
 * 区間 [lo, hi) のうち、音が一番小さいところの時刻を返す。
 * 波形が無い／範囲が空なら null。
 */
function quietestTime(waveform, lo, hi) {
  if (!waveform?.rms?.length || !(hi > lo)) return null;

  const perBucket = waveform.bucketFrames / waveform.sampleRate;
  const from = Math.max(0, Math.floor(lo / perBucket));
  const to = Math.min(waveform.rms.length, Math.ceil(hi / perBucket));
  if (to <= from) return null;

  let bestIndex = from;
  let bestValue = Infinity;
  for (let i = from; i < to; i += 1) {
    if (waveform.rms[i] < bestValue) {
      bestValue = waveform.rms[i];
      bestIndex = i;
    }
  }
  // バケットの中央を区切りにする（前後どちらの語尾も巻き込みにくい）
  return Math.min(hi, Math.max(lo, (bestIndex + 0.5) * perBucket));
}
