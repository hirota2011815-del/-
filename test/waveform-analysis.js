/**
 * 波形解析（音声のピーク/RMS抽出）の検証。
 *
 * test/fixture.js が秒ごとに振幅を変えて作るテスト動画
 * （大きい→標準→小さい→無音、4秒ずつ）を解析し、
 * 区間ごとに正しいdBが出ているかを確かめる。
 */
import { analyzeWaveform, concatFloat32, getAudioChannelCount } from '../src/audio/waveform.js';
import { aggregateRange, amplitudeToDb, HOT_THRESHOLD_DB } from '../src/audio/dbscale.js';
import { AMPLITUDE_BY_SECOND, FIXTURE, buildFixture } from './fixture.js';

const TEST_CODECS = { video: 'vp9', audio: 'opus' };

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

export async function runWaveformSuite() {
  results.length = 0;

  const source = await buildFixture(TEST_CODECS);

  const channels = await getAudioChannelCount(source);
  check('チャンネル数を取得できる（ステレオ）', channels === 2, `${channels}`);

  const progressLog = [];
  let peaks = new Float32Array(0);
  let rms = new Float32Array(0);
  let sampleRate = 0;
  let bucketFrames = 0;

  const result = await analyzeWaveform(source, (chunk) => {
    progressLog.push(chunk.ratio);
    peaks = concatFloat32(peaks, chunk.peaksSlice);
    rms = concatFloat32(rms, chunk.rmsSlice);
    sampleRate = chunk.sampleRate;
    bucketFrames = chunk.bucketFrames;
  });

  check('解析結果が返る（音声トラックあり）', result !== null);
  check('サンプルレートが元動画と一致', result.sampleRate === FIXTURE.sampleRate, `${result.sampleRate}`);
  check('チャンネル数が一致', result.channels === FIXTURE.channels, `${result.channels}`);
  check(
    '長さが元動画とほぼ一致',
    Math.abs(result.duration - FIXTURE.durationSec) < 0.1,
    `${result.duration}`,
  );

  check('進捗が複数回通知される', progressLog.length > 0, `${progressLog.length}回`);
  check('進捗は単調に増える', progressLog.every((r, i) => i === 0 || r >= progressLog[i - 1]));
  check('進捗は最後に1.0へ到達する', Math.abs(progressLog.at(-1) - 1) < 1e-9, `${progressLog.at(-1)}`);

  check(
    'チャンクを結合した配列の長さが最終結果と一致',
    peaks.length === result.peaks.length && rms.length === result.rms.length,
    `${peaks.length} / ${result.peaks.length}`,
  );

  /*
   * 区間ごとの音量チェック。
   * 0-4秒: 振幅0.95（-3dBを超える「音割れ危険」域） / 4-8秒: 0.3 / 8-11秒: 0.03（かなり小さい） / 11-12秒: 無音
   */
  const sections = [
    { label: '大きい区間(0-3秒)', t0: 0.2, t1: 3.8, amplitude: AMPLITUDE_BY_SECOND[0] },
    { label: '標準区間(4-7秒)', t0: 4.2, t1: 7.8, amplitude: AMPLITUDE_BY_SECOND[4] },
    { label: '小さい区間(8-10秒)', t0: 8.2, t1: 10.8, amplitude: AMPLITUDE_BY_SECOND[8] },
  ];
  for (const { label, t0, t1, amplitude } of sections) {
    const { peak } = aggregateRange(peaks, rms, sampleRate, bucketFrames, t0, t1);
    const expectedDb = amplitudeToDb(amplitude);
    const actualDb = amplitudeToDb(peak);
    check(
      `${label}: 検出したピークdBが理論値に近い`,
      Math.abs(actualDb - expectedDb) < 1.5,
      `実測 ${actualDb.toFixed(1)}dB / 理論 ${expectedDb.toFixed(1)}dB`,
    );
  }

  const loud = aggregateRange(peaks, rms, sampleRate, bucketFrames, 0.2, 3.8);
  check(
    '大きい区間はHOT_THRESHOLD_DB(-3dB)を超えている',
    amplitudeToDb(loud.peak) > HOT_THRESHOLD_DB,
    `${amplitudeToDb(loud.peak).toFixed(1)}dB`,
  );

  const quiet = aggregateRange(peaks, rms, sampleRate, bucketFrames, 8.2, 10.8);
  check(
    '小さい区間はHOT_THRESHOLD_DBを超えない',
    amplitudeToDb(quiet.peak) < HOT_THRESHOLD_DB,
    `${amplitudeToDb(quiet.peak).toFixed(1)}dB`,
  );

  const silent = aggregateRange(peaks, rms, sampleRate, bucketFrames, 11.1, 11.9);
  check(
    '無音区間はかなり低いdBになる',
    amplitudeToDb(silent.peak) < -40,
    `${amplitudeToDb(silent.peak).toFixed(1)}dB`,
  );

  /* --- 中止 --- */
  let canceled = false;
  let threwOrResolvedFast = false;
  const start = performance.now();
  try {
    await analyzeWaveform(source, () => {}, () => {
      canceled = true;
      return true; // 最初のチャンクが来る前から中止扱いにする
    });
  } catch (err) {
    threwOrResolvedFast = err?.name === 'WaveformCanceled';
  }
  check('中止フラグを立てるとすぐに止まる', canceled && threwOrResolvedFast, `${performance.now() - start}ms`);

  return results;
}
