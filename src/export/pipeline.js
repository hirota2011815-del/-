/**
 * 書き出し本体（ステップ1）。
 *
 *   元mp4 → demux → デコード → タイムスタンプを振り直す → 再エンコード → mp4に詰める
 *
 * 編集リストの有効なクリップを順に読み、出力タイムライン上の時刻へ並べ直す。
 * 速度変更は「映像はタイムスタンプの付け替え」「音声はリサンプル」で行う。
 *
 * ステップ1では全クリップを再エンコードする。フィルターも速度変更もないクリップを
 * 無劣化で通すパススルーは、Mediabunny の EncodedPacketSink で後のステップに足す。
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  VideoSampleSource,
} from '../../vendor/mediabunny.min.mjs';
import { AUDIO_CODEC, VIDEO_CODEC } from '../core/codecs.js';
import { enabledClips, outputDuration } from '../core/edit-list.js';
import { LinearResampler } from './resampler.js';
import { audioBitrate, videoBitrate } from './quality.js';

/** 一度に書き出す音声のかたまり（フレーム数）。小さいほど反応がよく、大きいほど速い。 */
const AUDIO_CHUNK_FRAMES = 2048;

/** 映像のキーフレーム間隔（秒）。 */
const KEY_FRAME_INTERVAL = 2;

export class ExportCanceled extends Error {
  constructor() {
    super('書き出しを中止しました');
    this.name = 'ExportCanceled';
  }
}

/**
 * @param {object} params
 * @param {Blob} params.file 元動画
 * @param {object} params.editList 編集リスト
 * @param {string} params.quality 'high' | 'standard' | 'light'
 * @param {(p: {phase: string, ratio: number, detail?: string}) => void} [params.onProgress]
 * @param {() => boolean} [params.isCanceled]
 * @param {{video: string, audio: string}} [params.codecs] 既定は H.264 / AAC。
 *   テストではヘッドレスChromiumが H.264 を持たないため VP9 / Opus に差し替える。
 * @returns {Promise<{buffer: ArrayBuffer, mimeType: string, durationSec: number, hasAudio: boolean,
 *   width: number, height: number, videoEncoderConfig: object|null, audioEncoderConfig: object|null}>}
 */
export async function runExport({
  file,
  editList,
  quality,
  onProgress = () => {},
  isCanceled = () => false,
  codecs = { video: VIDEO_CODEC, audio: AUDIO_CODEC },
}) {
  const clips = enabledClips(editList);
  if (clips.length === 0) throw new Error('書き出すクリップがありません。除外を解除してください。');

  const totalOut = outputDuration(editList);
  const checkCanceled = () => {
    if (isCanceled()) throw new ExportCanceled();
  };

  onProgress({ phase: 'prepare', ratio: 0, detail: '動画を読み込んでいます' });

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let output = null;

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('映像トラックが見つかりませんでした。');
    if (!(await videoTrack.canDecode())) {
      throw new Error('この端末ではこの動画の映像を読み込めません（コーデック非対応）。');
    }

    const audioTrack = await input.getPrimaryAudioTrack();
    const audioUsable = audioTrack ? await audioTrack.canDecode() : false;

    const width = await videoTrack.getCodedWidth();
    const height = await videoTrack.getCodedHeight();

    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });

    // 実機で何が使われたか報告できるよう、エンコーダが実際に受け取った設定を控えておく。
    let videoEncoderConfig = null;
    let audioEncoderConfig = null;

    const videoSource = new VideoSampleSource({
      codec: codecs.video,
      bitrate: videoBitrate(quality, width, height),
      keyFrameInterval: KEY_FRAME_INTERVAL,
      onEncoderConfig: (config) => {
        videoEncoderConfig = { codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate };
      },
    });
    // 回転はピクセルを回さずトラックのメタデータで持ち回す（縦向きで撮った動画が寝ないように）。
    output.addVideoTrack(videoSource, {
      transformationMatrix: await videoTrack.getTransformationMatrix(),
    });

    let audioSource = null;
    let audioChannels = 0;
    let audioSampleRate = 0;
    if (audioUsable) {
      audioChannels = await audioTrack.getNumberOfChannels();
      audioSampleRate = await audioTrack.getSampleRate();
      audioSource = new AudioSampleSource({
        codec: codecs.audio,
        bitrate: audioBitrate(audioChannels),
        onEncoderConfig: (config) => {
          audioEncoderConfig = { codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels };
        },
      });
      output.addAudioTrack(audioSource);
    }

    await output.start();

    const videoSink = new VideoSampleSink(videoTrack);
    const audioSink = audioUsable ? new AudioSampleSink(audioTrack) : null;

    let cursor = 0; // 出力タイムライン上の現在位置（秒）
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      const clipOutDuration = (clip.out - clip.in) / clip.speed;
      const detail = `クリップ ${i + 1}/${clips.length}`;

      // 映像と音声を同時に流すと同じ入力ファイルを2か所から読んで遅くなるので、順に処理する。
      await writeClipVideo({
        videoSink, videoSource, clip, cursor, totalOut, onProgress, checkCanceled, detail,
      });

      if (audioSink) {
        await writeClipAudio({
          audioSink, audioSource, clip, cursor, channels: audioChannels,
          sampleRate: audioSampleRate, checkCanceled,
        });
      }

      cursor += clipOutDuration;
    }

    onProgress({ phase: 'finalize', ratio: 0.99, detail: 'mp4にまとめています' });
    await output.finalize();
    checkCanceled();

    return {
      buffer: output.target.buffer,
      mimeType: await output.getMimeType(),
      durationSec: cursor,
      hasAudio: Boolean(audioSource),
      width,
      height,
      videoEncoderConfig,
      audioEncoderConfig,
    };
  } catch (err) {
    if (output && output.state !== 'finalized') {
      await output.cancel().catch(() => {});
    }
    throw err;
  } finally {
    try {
      input.dispose();
    } catch {
      /* 後片付けの失敗で書き出し結果を捨てる必要はない */
    }
  }
}

/** 1クリップぶんの映像を、出力時刻に並べ直して書き込む。 */
async function writeClipVideo({ videoSink, videoSource, clip, cursor, totalOut, onProgress, checkCanceled, detail }) {
  let lastTimestamp = -Infinity;

  for await (const sample of videoSink.samples(clip.in, clip.out)) {
    try {
      checkCanceled();

      // samples() は clip.in をまたぐフレームから返すので、クリップの頭で切り詰める。
      const srcStart = Math.max(sample.timestamp, clip.in);
      const srcEnd = Math.min(sample.timestamp + sample.duration, clip.out);
      if (srcEnd <= srcStart) continue;

      let timestamp = cursor + (srcStart - clip.in) / clip.speed;
      // タイムスタンプは必ず前へ進める（可変フレームレートで詰まったときの保険）。
      if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 1e-6;
      lastTimestamp = timestamp;

      sample.setTimestamp(timestamp);
      sample.setDuration((srcEnd - srcStart) / clip.speed);
      await videoSource.add(sample);

      if (totalOut > 0) {
        onProgress({ phase: 'encode', ratio: Math.min(0.98, timestamp / totalOut), detail });
      }
    } finally {
      sample.close();
    }
  }
}

/**
 * 1クリップぶんの音声を、速度ぶんリサンプルして書き込む。
 *
 * 出力の時刻は「書き込んだフレーム数 ÷ サンプルレート」で決める（仕様の
 * 「タイムスタンプを音声基準で振り直す」）。クリップの頭では名目の位置へ吸着させ、
 * クリップをまたぐ誤差が溜まらないようにする。
 */
async function writeClipAudio({ audioSink, audioSource, clip, cursor, channels, sampleRate, checkCanceled }) {
  const resampler = new LinearResampler(channels, clip.speed);

  let frameCursor = Math.round(cursor * sampleRate);
  /** @type {Float32Array[]} 出力待ちのバッファ */
  let buffered = Array.from({ length: channels }, () => new Float32Array(0));

  const emit = async (planes, force) => {
    buffered = planes.map((plane, ch) => concat(buffered[ch], plane));
    while (buffered[0].length >= (force ? 1 : AUDIO_CHUNK_FRAMES)) {
      const take = Math.min(AUDIO_CHUNK_FRAMES, buffered[0].length);
      const interleavedPlanar = new Float32Array(take * channels);
      for (let ch = 0; ch < channels; ch += 1) {
        interleavedPlanar.set(buffered[ch].subarray(0, take), ch * take);
        buffered[ch] = buffered[ch].slice(take);
      }
      const audioSample = new AudioSample({
        data: interleavedPlanar,
        format: 'f32-planar',
        numberOfChannels: channels,
        sampleRate,
        timestamp: frameCursor / sampleRate,
      });
      frameCursor += take;
      try {
        await audioSource.add(audioSample);
      } finally {
        audioSample.close();
      }
    }
  };

  for await (const sample of audioSink.samples(clip.in, clip.out)) {
    try {
      checkCanceled();
      const planes = extractPlanes(sample, channels);
      const trimmed = trimToRange(planes, sample, clip, sampleRate);
      if (trimmed[0].length === 0) continue;
      await emit(resampler.push(trimmed), false);
    } finally {
      sample.close();
    }
  }
  await emit(resampler.flush(), true);
}

/** AudioSample からチャンネルごとの Float32Array を取り出す。 */
function extractPlanes(sample, channels) {
  const planes = [];
  for (let ch = 0; ch < channels; ch += 1) {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
    planes.push(plane);
  }
  return planes;
}

/** クリップの範囲外にはみ出したサンプルを切り落とす。 */
function trimToRange(planes, sample, clip, sampleRate) {
  const startOffset = Math.max(0, Math.round((clip.in - sample.timestamp) * sampleRate));
  const endOffset = Math.min(
    sample.numberOfFrames,
    Math.round((clip.out - sample.timestamp) * sampleRate),
  );
  if (startOffset === 0 && endOffset === sample.numberOfFrames) return planes;
  if (endOffset <= startOffset) return planes.map(() => new Float32Array(0));
  return planes.map((p) => p.slice(startOffset, endOffset));
}

function concat(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
