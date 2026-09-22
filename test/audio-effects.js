/**
 * 音の仕上げが「書き出したファイル」に本当に効いているかの検証。
 *
 * ユニットテスト側（test/run-unit-tests.js）はDSP単体を確かめている。
 * こちらは書き出しパイプラインを通した結果をデコードし直して、
 * 音量・フェード・無音カットが出力に反映されているかを見る。
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from '../vendor/mediabunny.min.mjs';
import { analyzeWaveform } from '../src/audio/waveform.js';
import { amplitudeToDb } from '../src/audio/dbscale.js';
import { computeNormalizeGainDb, defaultAudioSettings } from '../src/audio/effects.js';
import { detectSoundedRanges } from '../src/audio/silence.js';
import { runExport } from '../src/export/pipeline.js';
import { AMPLITUDE_BY_SECOND, FIXTURE, buildFixture } from './fixture.js';

const TEST_CODECS = { video: 'vp9', audio: 'opus' };

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

/** 出力mp4の、ある時間範囲の振幅ピークを測る。 */
async function peakBetween(file, t0, t1) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return 0;
    const sink = new AudioSampleSink(track);
    let peak = 0;
    for await (const sample of sink.samples(t0, t1)) {
      try {
        const frames = sample.numberOfFrames;
        const plane = new Float32Array(frames);
        sample.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
        const sampleStart = sample.timestamp;
        for (let i = 0; i < frames; i += 1) {
          const t = sampleStart + i / sample.sampleRate;
          if (t < t0 || t >= t1) continue;
          const abs = Math.abs(plane[i]);
          if (abs > peak) peak = abs;
        }
      } finally {
        sample.close();
      }
    }
    return peak;
  } finally {
    input.dispose();
  }
}

function wholeClipList(duration, audio) {
  return {
    source: 'fixture.mp4',
    duration,
    clips: [{ id: 'a', in: 0, out: duration, speed: 1, enabled: true, filter: null }],
    audio,
    markers: [],
  };
}

export async function runAudioEffectsSuite() {
  results.length = 0;

  const source = await buildFixture(TEST_CODECS);
  const duration = FIXTURE.durationSec;

  /* --- エフェクトなしの出力を基準にする --- */
  const bypass = {
    normalize: false, normalizeGainDb: 0, clarity: false, highpassHz: 0, limiterDb: null, fade: false,
  };
  const plain = await runExport({
    file: source,
    editList: wholeClipList(duration, bypass),
    quality: 'standard',
    codecs: TEST_CODECS,
  });
  const plainFile = new File([plain.buffer], 'plain.mp4', { type: 'video/mp4' });

  // 0-4秒はテスト動画の「大きい」区間（振幅0.95 ≒ -0.4dB）
  const plainLoudPeak = await peakBetween(plainFile, 1, 3);
  check(
    'エフェクトを切ると元の音量のまま出てくる',
    Math.abs(amplitudeToDb(plainLoudPeak) - amplitudeToDb(AMPLITUDE_BY_SECOND[0])) < 1.5,
    `${amplitudeToDb(plainLoudPeak).toFixed(1)}dB`,
  );

  /* --- 音割れを防ぐ（リミッター） --- */
  const limited = await runExport({
    file: source,
    editList: wholeClipList(duration, { ...bypass, limiterDb: -1.5 }),
    quality: 'standard',
    codecs: TEST_CODECS,
  });
  const limitedPeak = await peakBetween(new File([limited.buffer], 'lim.mp4'), 1, 3);
  check(
    'リミッターONで上限(-1.5dB)を大きく超えない',
    amplitudeToDb(limitedPeak) < -0.5,
    `${amplitudeToDb(limitedPeak).toFixed(1)}dB`,
  );

  /* --- 音量をそろえる（小さい区間だけを書き出して持ち上げる） --- */
  let peaks = new Float32Array(0);
  let rms = new Float32Array(0);
  let sampleRate = 0;
  let bucketFrames = 0;
  await analyzeWaveform(source, (chunk) => {
    const merged = new Float32Array(peaks.length + chunk.peaksSlice.length);
    merged.set(peaks, 0);
    merged.set(chunk.peaksSlice, peaks.length);
    peaks = merged;
    const mergedRms = new Float32Array(rms.length + chunk.rmsSlice.length);
    mergedRms.set(rms, 0);
    mergedRms.set(chunk.rmsSlice, rms.length);
    rms = mergedRms;
    sampleRate = chunk.sampleRate;
    bucketFrames = chunk.bucketFrames;
  });
  const waveform = { peaks, rms, sampleRate, bucketFrames };

  // 8-11秒は「小さい」区間（振幅0.03 ≒ -30dB）。ここだけのクリップなら大きく持ち上がるはず。
  const quietClips = [{ id: 'q', in: 8.2, out: 10.8, speed: 1, enabled: true, filter: null }];
  const normalizeGainDb = computeNormalizeGainDb(waveform, quietClips);
  check(
    '小さい区間の補正量が大きめに計算される',
    normalizeGainDb > 20,
    `${normalizeGainDb}dB`,
  );

  const normalized = await runExport({
    file: source,
    editList: {
      source: 'fixture.mp4',
      duration,
      clips: quietClips,
      audio: { ...bypass, normalize: true, normalizeGainDb },
      markers: [],
    },
    quality: 'standard',
    codecs: TEST_CODECS,
  });
  const normalizedPeak = await peakBetween(new File([normalized.buffer], 'norm.mp4'), 0.5, 2);
  check(
    '音量をそろえるとピークが-3dB付近まで持ち上がる',
    Math.abs(amplitudeToDb(normalizedPeak) - -3) < 3,
    `${amplitudeToDb(normalizedPeak).toFixed(1)}dB`,
  );

  /* --- 出だしと終わりのフェード --- */
  const faded = await runExport({
    file: source,
    editList: wholeClipList(duration, { ...bypass, fade: true }),
    quality: 'standard',
    codecs: TEST_CODECS,
  });
  const fadedFile = new File([faded.buffer], 'fade.mp4', { type: 'video/mp4' });
  const headPeak = await peakBetween(fadedFile, 0, 0.1);
  const bodyPeak = await peakBetween(fadedFile, 1, 3);
  check(
    'フェードONで出だしが絞られている',
    amplitudeToDb(headPeak) < amplitudeToDb(bodyPeak) - 6,
    `頭 ${amplitudeToDb(headPeak).toFixed(1)}dB / 中 ${amplitudeToDb(bodyPeak).toFixed(1)}dB`,
  );
  const tailPeak = await peakBetween(fadedFile, duration - 0.1, duration);
  check(
    'フェードONで終わりも絞られている',
    amplitudeToDb(tailPeak) < amplitudeToDb(bodyPeak) - 6,
    `尻 ${amplitudeToDb(tailPeak).toFixed(1)}dB`,
  );

  /* --- 無音の自動カット --- */
  // テスト動画の11-12秒は完全な無音なので、そこが「間」として外れるはず。
  const ranges = detectSoundedRanges(waveform, { duration, thresholdDb: -45 });
  check('無音カットで区間が検出される', ranges.length > 0, `${ranges.length}個`);
  check(
    '最後の無音区間（11-12秒）が外れている',
    ranges.every((r) => r.in >= 11 || r.out <= 11.3),
    JSON.stringify(ranges.map((r) => [Number(r.in.toFixed(2)), Number(r.out.toFixed(2))])),
  );

  const cut = await runExport({
    file: source,
    editList: {
      source: 'fixture.mp4',
      duration,
      clips: ranges.map((r, i) => ({ id: `s${i}`, in: r.in, out: r.out, speed: 1, enabled: true, filter: null })),
      audio: defaultAudioSettings(),
      markers: [],
    },
    quality: 'standard',
    codecs: TEST_CODECS,
  });
  const keptSec = ranges.reduce((sum, r) => sum + (r.out - r.in), 0);
  check(
    '無音カット後の書き出しが短くなっている',
    cut.durationSec < duration - 0.5 && Math.abs(cut.durationSec - keptSec) < 0.3,
    `${cut.durationSec.toFixed(2)}秒（元 ${duration}秒）`,
  );

  return results;
}
