/**
 * テスト用の動画をブラウザ内で作る。
 *
 * 1秒ごとに色が変わる 12秒の動画。書き出し後にフレームの色を読めば、
 * 「出力の何秒目に、元動画の何秒目のフレームが来ているか」が分かる。
 * 音声は秒ごとに高さの変わるサイン波。
 */
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
} from '../vendor/mediabunny.min.mjs';

/** 秒ごとの色。VP9の圧縮を通しても見分けがつくよう、離れた色を選んである。 */
export const SECOND_COLORS = [
  [220, 20, 20], [20, 200, 20], [20, 20, 220], [230, 230, 20],
  [220, 20, 220], [20, 220, 220], [250, 250, 250], [20, 20, 20],
  [240, 130, 20], [120, 20, 200], [20, 140, 90], [130, 130, 130],
];

/**
 * 秒ごとの音量パターン（4秒ずつ: 大きい→標準→小さい→無音）。
 * 大きい区間の振幅0.95は 20*log10(0.95)≈-0.45dB で、-3dBを超える「音割れ危険」域に入る。
 */
export const AMPLITUDE_BY_SECOND = [0.95, 0.95, 0.95, 0.95, 0.3, 0.3, 0.3, 0.3, 0.03, 0.03, 0.03, 0];

export const FIXTURE = {
  width: 320,
  height: 180,
  fps: 30,
  durationSec: 12,
  sampleRate: 48000,
  channels: 2,
};

/** 色から「元動画の何秒目か」を逆算する。一致するものがなければ null。 */
export function colorToSecond(r, g, b, tolerance = 45) {
  let best = null;
  let bestDist = Infinity;
  SECOND_COLORS.forEach((c, i) => {
    const d = Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return bestDist <= tolerance * 3 ? best : null;
}

/**
 * @param {{video: string, audio: string}} codecs
 * @param {{rotation?: 0|90|180|270}} [options]
 *   rotation を指定すると「ピクセルは横向きのまま、再生時に回して表示せよ」という
 *   メタデータ付きの動画になる（スマホの縦撮りと同じ形）。
 * @returns {Promise<File>}
 */
export async function buildFixture(codecs, options = {}) {
  const { width, height, fps, durationSec, sampleRate, channels } = FIXTURE;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const videoSource = new VideoSampleSource({
    codec: codecs.video,
    bitrate: 2_000_000,
    keyFrameInterval: 1,
  });
  output.addVideoTrack(videoSource, options.rotation ? { rotation: options.rotation } : undefined);

  const audioSource = new AudioSampleSource({ codec: codecs.audio, bitrate: 128_000 });
  output.addAudioTrack(audioSource);

  await output.start();

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const totalFrames = durationSec * fps;

  for (let i = 0; i < totalFrames; i += 1) {
    const t = i / fps;
    const [r, g, b] = SECOND_COLORS[Math.floor(t) % SECOND_COLORS.length];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, width, height);

    const sample = new VideoSample(canvas, { timestamp: t, duration: 1 / fps });
    await videoSource.add(sample);
    sample.close();
  }

  // 音声: 0.1秒ずつ、その秒に応じた高さ・振幅のサイン波。
  // 振幅は AMPLITUDE_BY_SECOND のとおり4秒ずつ「大きい→標準→小さい→無音」と切り替える。
  // これで波形解析のテストが、区間ごとに違うdBを検出できているか確かめられる。
  const blockFrames = sampleRate / 10;
  const totalBlocks = durationSec * 10;
  for (let blk = 0; blk < totalBlocks; blk += 1) {
    const startFrame = blk * blockFrames;
    const data = new Float32Array(blockFrames * channels);
    for (let n = 0; n < blockFrames; n += 1) {
      const globalFrame = startFrame + n;
      const second = Math.floor(globalFrame / sampleRate);
      const freq = 220 * (1 + second * 0.1);
      const amplitude = AMPLITUDE_BY_SECOND[second % AMPLITUDE_BY_SECOND.length];
      const v = Math.sin((2 * Math.PI * freq * globalFrame) / sampleRate) * amplitude;
      data[n] = v;
      data[blockFrames + n] = v;
    }
    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: channels,
      sampleRate,
      timestamp: startFrame / sampleRate,
    });
    await audioSource.add(sample);
    sample.close();
  }

  await output.finalize();
  return new File([output.target.buffer], 'fixture.mp4', { type: 'video/mp4' });
}
