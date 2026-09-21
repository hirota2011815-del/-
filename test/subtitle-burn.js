/**
 * 字幕の焼き込みの検証（ブラウザ内）。
 *
 * 焼き込みは「出来上がったmp4のピクセルに文字が乗っているか」でしか確かめられない。
 * テスト動画は1秒ごとの単色なので、字幕の文字（白）が乗った画素を数えれば判定できる。
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from '../vendor/mediabunny.min.mjs';
import { runExport } from '../src/export/pipeline.js';
import { FIXTURE, colorToSecond, buildFixture } from './fixture.js';
import { defaultSubtitleStyle } from '../src/subtitles/styles.js';

const TEST_CODECS = { video: 'vp9', audio: 'opus' };

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

export async function runSubtitleSuite() {
  results.length = 0;

  const source = await buildFixture(TEST_CODECS);

  const baseList = {
    source: 'fixture.mp4',
    duration: FIXTURE.durationSec,
    clips: [{ id: 'a', in: 0, out: 6, speed: 1, enabled: true, filter: null }],
    audio: { normalizeGainDb: 0, highpassHz: 0, limiterDb: -1.5 },
    subtitles: [],
    subtitleStyle: defaultSubtitleStyle(),
    markers: [],
  };

  /* --- 字幕なしのときは何も変わらないこと（基準） --- */
  const plain = await runExport({ file: source, editList: baseList, quality: 'standard', codecs: TEST_CODECS });
  const plainFile = new File([plain.buffer], 'plain.mp4', { type: 'video/mp4' });
  const plainInk = await inspectFrames(plainFile, [1.5, 4.5]);
  check(
    '字幕がないときは下に文字が乗らない',
    plainInk[0].whitePixels === 0 && plainInk[1].whitePixels === 0,
    `${plainInk[0].whitePixels} / ${plainInk[1].whitePixels}`,
  );
  check('字幕なしでは焼き込みを通さない', plain.burnedSubtitles === 0, `${plain.burnedSubtitles}`);

  /* --- 字幕ありのとき、出ている時間にだけ文字が乗ること --- */
  const withSubs = {
    ...baseList,
    // 出力1秒〜3秒（＝元動画の1秒〜3秒）にだけ出す
    subtitles: [{ id: 's1', start: 1, end: 3, text: 'SUB' }],
  };
  const burned = await runExport({ file: source, editList: withSubs, quality: 'standard', codecs: TEST_CODECS });
  const burnedFile = new File([burned.buffer], 'burned.mp4', { type: 'video/mp4' });

  check('字幕ありでも書き出せる', burned.buffer.byteLength > 1000, `${burned.buffer.byteLength} bytes`);
  check(
    '焼き込んでも解像度が変わらない',
    burned.width === FIXTURE.width && burned.height === FIXTURE.height,
    `${burned.width}x${burned.height}`,
  );
  check(
    '焼き込んでもフレームが落ちない',
    burned.framesSubmitted === burned.packetsEncoded && burned.framesSubmitted > 0,
    `投入 ${burned.framesSubmitted} / 出力 ${burned.packetsEncoded}`,
  );

  const ink = await inspectFrames(burnedFile, [0.5, 1.5, 2.5, 4.5]);
  check('字幕の前（0.5秒）には文字が出ていない', ink[0].whitePixels === 0, `${ink[0].whitePixels}画素`);
  check('字幕の中（1.5秒）に文字が出ている', ink[1].whitePixels > 5, `${ink[1].whitePixels}画素`);
  check('字幕の中（2.5秒）にも文字が出ている', ink[2].whitePixels > 5, `${ink[2].whitePixels}画素`);
  check('字幕の後（4.5秒）には文字が出ていない', ink[3].whitePixels === 0, `${ink[3].whitePixels}画素`);

  // 焼き込みで映像そのものが壊れていないこと（中央の色＝元の秒が合っている）
  const seconds = ink.map((f) => f.second);
  check(
    '焼き込んでも映像の中身が変わらない',
    JSON.stringify(seconds) === JSON.stringify([0, 1, 2, 4]),
    JSON.stringify(seconds),
  );

  /* --- 位置の指定が焼き込みに効くこと --- */
  const topStyle = { ...defaultSubtitleStyle(), position: 'top' };
  const topBurned = await runExport({
    file: source,
    editList: { ...withSubs, subtitleStyle: topStyle },
    quality: 'standard',
    codecs: TEST_CODECS,
  });
  const topInk = await inspectFrames(new File([topBurned.buffer], 'top.mp4'), [1.5]);
  check(
    '「上」を選ぶと上に出る',
    topInk[0].whitePixelsTop > 5 && topInk[0].whitePixels === 0,
    `上 ${topInk[0].whitePixelsTop} / 下 ${topInk[0].whitePixels}`,
  );

  /* --- カットをまたいでも、字幕が元動画の言葉に貼り付いたままであること --- */
  {
    // 元の0〜1秒を外す。字幕は元動画の1〜3秒のままなので、出力では0〜2秒に出るはず。
    const cut = {
      ...withSubs,
      clips: [
        { id: 'skip', in: 0, out: 1, speed: 1, enabled: false, filter: null },
        { id: 'keep', in: 1, out: 6, speed: 1, enabled: true, filter: null },
      ],
    };
    const cutBurned = await runExport({ file: source, editList: cut, quality: 'standard', codecs: TEST_CODECS });
    const cutInk = await inspectFrames(new File([cutBurned.buffer], 'cut.mp4'), [0.5, 1.5, 3.5]);
    check(
      'カットしても字幕が言葉についていく',
      cutInk[0].whitePixels > 5 && cutInk[1].whitePixels > 5 && cutInk[2].whitePixels === 0,
      `0.5秒 ${cutInk[0].whitePixels} / 1.5秒 ${cutInk[1].whitePixels} / 3.5秒 ${cutInk[2].whitePixels}`,
    );
  }

  /* --- 縦撮り（回転メタデータ付き）の動画に焼き込んでも横倒しにならないこと --- */
  {
    /*
     * スマホの縦動画は、ピクセルは横向きのまま「90度回して表示せよ」という指示が
     * 入っている。焼き込みはピクセルを先に起こしてから字幕を描くので、
     *  - 出来上がりの縦横が入れ替わる（320x180 → 180x320）
     *  - 「回して表示せよ」の指示は付かない（付くと二重に回る）
     *  - 字幕は起こしたあとの下に出る
     * の3つが成り立っていないといけない。
     */
    const rotated = await buildFixture(TEST_CODECS, { rotation: 90 });
    const upright = { width: FIXTURE.height, height: FIXTURE.width };

    const rotatedPlain = await runExport({
      file: rotated, editList: baseList, quality: 'standard', codecs: TEST_CODECS,
    });
    check(
      '字幕が無ければ回転は指示のまま引き渡す',
      rotatedPlain.width === FIXTURE.width && rotatedPlain.height === FIXTURE.height,
      `${rotatedPlain.width}x${rotatedPlain.height}`,
    );

    const rotatedBurned = await runExport({
      file: rotated, editList: withSubs, quality: 'standard', codecs: TEST_CODECS,
    });
    check(
      '焼き込むと縦横が起こされる',
      rotatedBurned.width === upright.width && rotatedBurned.height === upright.height,
      `${rotatedBurned.width}x${rotatedBurned.height}`,
    );

    const rotatedFile = new File([rotatedBurned.buffer], 'rotated.mp4', { type: 'video/mp4' });
    const rotatedInk = await inspectFrames(rotatedFile, [0.5, 1.5], upright);
    check(
      '縦撮りでも字幕は下に出る',
      rotatedInk[1].whitePixels > 5 && rotatedInk[1].whitePixelsTop === 0,
      `下 ${rotatedInk[1].whitePixels} / 上 ${rotatedInk[1].whitePixelsTop}`,
    );
    check('縦撮りでも字幕の時間は合っている', rotatedInk[0].whitePixels === 0, `${rotatedInk[0].whitePixels}画素`);
    check(
      '縦撮りでも映像の中身が変わらない',
      rotatedInk[1].second === 1,
      `${rotatedInk[1].second}`,
    );
  }

  return results;
}

/**
 * 指定した出力時刻のフレームを読み、
 * 「下に乗った白い画素の数」「上に乗った白い画素の数」「中央の色から分かる元の秒」を返す。
 */
async function inspectFrames(file, timestamps, size = { width: FIXTURE.width, height: FIXTURE.height }) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track);
    const w = size.width;
    const h = size.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const out = [];
    for (const t of timestamps) {
      const sample = await sink.getSample(t);
      if (!sample) {
        out.push({ whitePixels: 0, whitePixelsTop: 0, second: null });
        continue;
      }
      sample.draw(ctx, 0, 0, w, h);
      sample.close();

      const center = ctx.getImageData(w >> 1, h >> 1, 1, 1).data;
      out.push({
        // 下30%・上30%の帯を見る。テスト動画の色はどれも白ではないので、
        // 真っ白に近い画素があれば字幕の文字だと分かる。
        whitePixels: countWhite(ctx, 0, Math.floor(h * 0.7), w, Math.ceil(h * 0.3)),
        whitePixelsTop: countWhite(ctx, 0, 0, w, Math.ceil(h * 0.3)),
        second: colorToSecond(center[0], center[1], center[2]),
      });
    }
    return out;
  } finally {
    input.dispose();
  }
}

/** 真っ白に近い画素の数。圧縮でにじむので、しきい値は高めに取る。 */
function countWhite(ctx, x, y, w, h) {
  const { data } = ctx.getImageData(x, y, w, h);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 225 && data[i + 1] > 225 && data[i + 2] > 225) count += 1;
  }
  return count;
}
