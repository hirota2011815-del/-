/**
 * ブラウザ内で走らせる書き出しの検証。
 *
 * 1秒ごとに色が変わるテスト動画を作り、カット・除外・速度変更を指定して書き出し、
 * 出来上がったmp4をデコードし直して「出力の各時点に、元動画の正しい秒のフレームが
 * 来ているか」と「長さが合っているか」を確かめる。
 */
import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
  VideoSampleSink,
} from '../vendor/mediabunny.min.mjs';
import { runExport } from '../src/export/pipeline.js';
import { outputDuration } from '../src/core/edit-list.js';
import { FIXTURE, buildFixture, colorToSecond } from './fixture.js';

/** ヘッドレスChromiumはH.264/AACを持たないので、同じmp4コンテナのままVP9/Opusで通す。 */
const TEST_CODECS = { video: 'vp9', audio: 'opus' };

const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

function approx(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

export async function runSuite() {
  results.length = 0;

  const source = await buildFixture(TEST_CODECS);
  check('テスト動画を生成できる', source.size > 1000, `${source.size} bytes`);

  // 元動画そのものが正しく読めることを先に確かめる（以降の判定の前提）
  const sourceSeconds = await sampleSeconds(source, [0.5, 3.5, 7.5, 11.5]);
  check(
    '元動画のフレームの色が秒と一致する',
    JSON.stringify(sourceSeconds) === JSON.stringify([0, 3, 7, 11]),
    JSON.stringify(sourceSeconds),
  );

  const editList = {
    source: 'fixture.mp4',
    duration: FIXTURE.durationSec,
    clips: [
      { id: 'a', in: 0, out: 2, speed: 1, enabled: true, filter: null },
      { id: 'skip', in: 2, out: 4, speed: 1, enabled: false, filter: null },
      { id: 'b', in: 4, out: 6, speed: 2, enabled: true, filter: null },
      { id: 'skip2', in: 6, out: 8, speed: 1, enabled: false, filter: null },
      { id: 'c', in: 8, out: 10, speed: 0.5, enabled: true, filter: null },
      { id: 'skip3', in: 10, out: 12, speed: 1, enabled: false, filter: null },
    ],
    audio: { normalizeGainDb: 0, highpassHz: 0, limiterDb: -1.5 },
    markers: [],
  };

  // 2秒(×1) + 1秒(4-6秒を×2) + 4秒(8-10秒を×0.5) = 7秒
  const expectedDuration = outputDuration(editList);
  check('編集リストの計算上の長さが7秒', approx(expectedDuration, 7, 0.001), `${expectedDuration}`);

  const progress = [];
  const exported = await runExport({
    file: source,
    editList,
    quality: 'standard',
    codecs: TEST_CODECS,
    onProgress: (p) => progress.push(p),
  });

  check('mp4が出力される', exported.buffer.byteLength > 1000, `${exported.buffer.byteLength} bytes`);
  check('進捗が通知される', progress.length > 5, `${progress.length} 回`);
  check(
    '進捗が単調に増える',
    progress.every((p, i) => i === 0 || p.ratio >= progress[i - 1].ratio - 1e-9),
  );
  check('音声トラックが入っている', exported.hasAudio === true);
  check(
    '解像度が元のまま',
    exported.width === FIXTURE.width && exported.height === FIXTURE.height,
    `${exported.width}x${exported.height}`,
  );
  check(
    '実際に使われたエンコーダ設定が取れる',
    Boolean(exported.videoEncoderConfig?.codec) && Boolean(exported.audioEncoderConfig?.codec),
    `${exported.videoEncoderConfig?.codec} / ${exported.audioEncoderConfig?.codec}`,
  );

  const outFile = new File([exported.buffer], 'out.mp4', { type: 'video/mp4' });

  const actualDuration = await realDuration(outFile);
  check(
    '書き出したmp4の長さが約7秒',
    approx(actualDuration, 7, 0.25),
    `${actualDuration.toFixed(3)} 秒`,
  );

  /*
   * 出力時刻 → 期待する元動画の秒
   *   0.0-2.0 : クリップA（等速）    → 0秒, 1秒
   *   2.0-3.0 : クリップB（×2）      → 4秒, 5秒が半分の時間に詰まる
   *   3.0-7.0 : クリップC（×0.5）    → 8秒, 9秒が倍の時間に伸びる
   */
  const probes = [
    [0.4, 0], [1.4, 1],
    [2.2, 4], [2.7, 5],
    [3.4, 8], [4.8, 8], [5.2, 9], [6.6, 9],
  ];
  const observed = await sampleSeconds(outFile, probes.map((p) => p[0]));
  probes.forEach(([t, expected], i) => {
    check(
      `出力 ${t}秒 に 元の${expected}秒 のフレームが来る`,
      observed[i] === expected,
      `実際: ${observed[i]}`,
    );
  });

  const audioInfo = await audioSummary(outFile);
  check('音声のサンプルレートが保たれる', audioInfo.sampleRate === FIXTURE.sampleRate, `${audioInfo.sampleRate}`);
  check('音声の長さが約7秒', approx(audioInfo.duration, 7, 0.25), `${audioInfo.duration.toFixed(3)} 秒`);
  check(
    '音声が映像とほぼ同じ長さ（ずれ0.2秒以内）',
    approx(audioInfo.duration, actualDuration, 0.2),
    `映像 ${actualDuration.toFixed(3)} / 音声 ${audioInfo.duration.toFixed(3)}`,
  );

  /*
   * 実機で出た不具合の回帰テスト。
   *
   * mp4に詰める側には「直前のキーフレーム時点の最大タイムスタンプより小さい値は
   * 入れられない」という決まりがある。クリップを細かく分けると切れ目の数が増え、
   * そこで時刻が巻き戻ると書き出しが止まる。
   * 実機（Safari/H.264）ではエンコーダのフレーム並べ替えでこれが起き、
   * latencyMode: 'realtime' で並べ替えを止めて直した。
   * ここでは自分の側の時刻付けが、細かいクリップでも必ず前へ進むことを確かめる。
   */
  {
    const manyClips = [];
    let t = 0.05;
    // 長さを不揃いにする（無音カットの結果はこうなる）
    const lengths = [0.83, 0.42, 1.17, 0.35, 0.94, 0.51, 0.28, 0.76, 0.63, 0.39];
    for (let i = 0; i < lengths.length && t + lengths[i] < FIXTURE.durationSec; i += 1) {
      manyClips.push({ id: `m${i}`, in: t, out: t + lengths[i], speed: 1, enabled: true, filter: null });
      t += lengths[i] + 0.11;
    }

    let exportedMany = null;
    let manyError = null;
    try {
      exportedMany = await runExport({
        file: source,
        editList: { ...editList, clips: manyClips },
        quality: 'standard',
        codecs: TEST_CODECS,
      });
    } catch (err) {
      manyError = err?.message ?? String(err);
    }
    check(`クリップを${manyClips.length}個に細かく分けても書き出せる`, manyError === null, manyError ?? '');

    if (exportedMany) {
      check(
        'フレームが落ちていない',
        exportedMany.framesSubmitted === exportedMany.packetsEncoded,
        `投入 ${exportedMany.framesSubmitted} / 出力 ${exportedMany.packetsEncoded}`,
      );

      // 出来上がったファイルのフレーム時刻が、実際に前へ進んでいるか確かめる
      const timestamps = await frameTimestamps(new File([exportedMany.buffer], 'many.mp4'));
      let backwards = 0;
      for (let i = 1; i < timestamps.length; i += 1) {
        if (timestamps[i] < timestamps[i - 1]) backwards += 1;
      }
      check('出力フレームの時刻が巻き戻らない', backwards === 0, `巻き戻り ${backwards}回 / ${timestamps.length}フレーム`);
    }
  }

  // 全クリップ除外はエラーになること
  const allDisabled = { ...editList, clips: editList.clips.map((c) => ({ ...c, enabled: false })) };
  let threw = false;
  try {
    await runExport({ file: source, editList: allDisabled, quality: 'standard', codecs: TEST_CODECS });
  } catch {
    threw = true;
  }
  check('全部除外すると書き出さずにエラーになる', threw);

  return results;
}

/** 指定した出力時刻のフレームを取り出し、色から「元動画の何秒目か」を返す。 */
async function sampleSeconds(file, timestamps) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track);
    const canvas = new OffscreenCanvas(FIXTURE.width, FIXTURE.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const t of timestamps) {
      const sample = await sink.getSample(t);
      if (!sample) {
        out.push(null);
        continue;
      }
      sample.draw(ctx, 0, 0, FIXTURE.width, FIXTURE.height);
      sample.close();
      // 端はエンコーダのリンギングが出るので中央を読む
      const px = ctx.getImageData(FIXTURE.width >> 1, FIXTURE.height >> 1, 1, 1).data;
      out.push(colorToSecond(px[0], px[1], px[2]));
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** 出力mp4の全フレームの表示時刻を、表示順で取り出す。 */
async function frameTimestamps(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track);
    const out = [];
    for await (const sample of sink.samples()) {
      out.push(sample.timestamp);
      sample.close();
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** 最後のフレームの終端から、実際の長さを測る。 */
async function realDuration(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    return await input.computeDuration();
  } finally {
    input.dispose();
  }
}

async function audioSummary(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { sampleRate: 0, duration: 0 };
    const sink = new AudioSampleSink(track);
    let last = 0;
    for await (const sample of sink.samples()) {
      last = Math.max(last, sample.timestamp + sample.duration);
      sample.close();
    }
    return { sampleRate: await track.getSampleRate(), duration: last };
  } finally {
    input.dispose();
  }
}
