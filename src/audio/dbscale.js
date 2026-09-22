/**
 * dB表示まわりの純粋関数（DOM・Web Audio非依存、ユニットテスト対象）。
 *
 * 単位はdBFS。0dBが0dBFS（振幅1.0＝音割れ上限）。
 */

/** 波形・メーターで表示する範囲。これより低い音は全部この値に丸めて描く。 */
export const DB_FLOOR = -60;
export const DB_CEILING = 0;

/** 波形のグリッド線（仕様どおりの目盛り）。 */
export const GRID_DB_LINES = [0, -3, -6, -12, -20, -40];

/** これを超える列を赤く強調する（音割れ危険）。 */
export const HOT_THRESHOLD_DB = -3;

/** CLIPランプが点灯するしきい値。 */
export const CLIP_THRESHOLD_DB = -0.6;

/** ピークホールドの保持時間（秒）。 */
export const PEAK_HOLD_SEC = 1.1;

/** 振幅（0以上、目安として0〜1）をdBFSに変換する。無音はDB_FLOORに丸める。 */
export function amplitudeToDb(amplitude) {
  if (!(amplitude > 0)) return DB_FLOOR;
  const db = 20 * Math.log10(amplitude);
  return Math.max(DB_FLOOR, db);
}

/** dBFSを振幅に戻す（メーターのしきい値判定などで使う）。 */
export function dbToAmplitude(db) {
  return 10 ** (db / 20);
}

/**
 * dB値を、高さhの領域内でのy座標に変換する。
 * y=0 が DB_CEILING（上端）、y=h が DB_FLOOR（下端）。
 */
export function dbToY(db, height) {
  const clamped = Math.min(DB_CEILING, Math.max(DB_FLOOR, db));
  const ratio = (DB_CEILING - clamped) / (DB_CEILING - DB_FLOOR);
  return ratio * height;
}

/**
 * バケット配列（一定フレーム数ごとの振幅ピーク／RMS）から、
 * 任意の時間範囲 [t0, t1) を1組のpeak/rms（振幅、線形）に集約する。
 *
 * ズーム倍率が変わっても、解析をやり直さずこの集約だけで描画できるのが要点。
 * バケットの大きさが揃っている前提で、RMSは二乗平均を平均してから平方根を取る
 * （バケット数が揃っていれば、これは連結後のRMSと厳密に一致する）。
 */
export function aggregateRange(peaks, rms, sampleRate, bucketFrames, t0, t1) {
  if (peaks.length === 0) return { peak: 0, rms: 0 };
  const bucketDuration = bucketFrames / sampleRate;
  const startIndex = Math.max(0, Math.floor(t0 / bucketDuration));
  const endIndex = Math.min(peaks.length, Math.ceil(t1 / bucketDuration));

  if (endIndex <= startIndex) {
    // 表示範囲がバケット1個より狭い（ズームしすぎ）。一番近い1個をそのまま使う。
    const i = Math.min(peaks.length - 1, Math.max(0, Math.round(t0 / bucketDuration)));
    return { peak: peaks[i], rms: rms[i] };
  }

  let peak = 0;
  let sumSquares = 0;
  for (let i = startIndex; i < endIndex; i += 1) {
    if (peaks[i] > peak) peak = peaks[i];
    sumSquares += rms[i] * rms[i];
  }
  const count = endIndex - startIndex;
  return { peak, rms: Math.sqrt(sumSquares / count) };
}

/** 判断基準の目安ラベル（UIの説明表示用）。 */
export function loudnessHint(db) {
  if (db > HOT_THRESHOLD_DB) return { tone: 'danger', text: '音割れ危険' };
  if (db > -12) return { tone: 'warn', text: 'やや大きい' };
  if (db > -24) return { tone: 'ok', text: 'ちょうどいい' };
  return { tone: 'low', text: '小さすぎる' };
}
