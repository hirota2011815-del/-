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
import { createEffectChain, defaultAudioSettings, hasAnyEffect } from '../audio/effects.js';
import { AUDIO_CODEC, VIDEO_CODEC } from '../core/codecs.js';
import { enabledClips, outputDuration } from '../core/edit-list.js';
import { LinearResampler } from './resampler.js';
import { audioBitrate, videoBitrate } from './quality.js';
import { isTimestampOrderError, serialEncoding } from './serial-encoder.js';

/** 一度に書き出す音声のかたまり（フレーム数）。小さいほど反応がよく、大きいほど速い。 */
const AUDIO_CHUNK_FRAMES = 2048;

/** 映像のキーフレーム間隔（秒）。 */
const KEY_FRAME_INTERVAL = 2;

/** 時刻が前へ進まなかったときに足す最小の刻み（秒）。 */
const MIN_FRAME_STEP = 1e-6;

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
export async function runExport(params) {
  try {
    return await encodeOnce(params);
  } catch (err) {
    // フレームの並べ替えで詰まった場合だけ、並べ替えの起きないやり方で1度だけやり直す。
    if (!isTimestampOrderError(err) || serialEncoding.enabled) throw err;
    params.onProgress?.({ phase: 'prepare', ratio: 0, detail: '並べ替えを避けてやり直しています' });
    serialEncoding.enabled = true;
    try {
      const result = await encodeOnce(params);
      return { ...result, usedSerialEncoder: true };
    } finally {
      serialEncoding.enabled = false;
    }
  }
}

async function encodeOnce({
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
  const audioSettings = { ...defaultAudioSettings(), ...(editList.audio ?? {}) };
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
    // フレーム落ちの検出用（latencyMode: 'realtime' の副作用を見張る）。
    let framesSubmitted = 0;
    let packetsEncoded = 0;

    const videoSource = new VideoSampleSource({
      codec: codecs.video,
      bitrate: videoBitrate(quality, width, height),
      keyFrameInterval: KEY_FRAME_INTERVAL,
      /*
       * フレームの並べ替え（Bフレーム）を止める。
       *
       * 既定の 'quality' だと、エンコーダはキーフレームをまたいで参照する
       * フレームを出すことがある。するとパケットが「表示順では前のGOPに属するのに
       * キーフレームより後に出てくる」状態になり、mp4に詰める側の
       *   「直前のキーフレーム時点の最大タイムスタンプより小さい値は入れられない」
       * という検査に引っかかって書き出しが止まる。
       * （実機のSafari/H.264で発生。Bフレームを出さないVP9のテストでは再現しない）
       *
       * 'realtime' は「詰まるとフレームを落とすことがある」とされているので、
       * 投入したフレーム数と実際に出てきたパケット数を数えて食い違いを検出する。
       */
      latencyMode: 'realtime',
      onEncoderConfig: (config) => {
        videoEncoderConfig = { codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate };
      },
      onEncodedPacket: () => {
        packetsEncoded += 1;
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
    const audioWriter = audioSink
      ? new AudioOutputWriter({
          audioSource,
          channels: audioChannels,
          sampleRate: audioSampleRate,
          effectChain: hasAnyEffect(audioSettings)
            ? createEffectChain({
                sampleRate: audioSampleRate,
                channels: audioChannels,
                audio: audioSettings,
                totalDurationSec: totalOut,
              })
            : null,
        })
      : null;

    let cursor = 0; // 出力タイムライン上の現在位置（秒）
    // 出した映像フレームの時刻はクリップをまたいで必ず前へ進める必要がある
    // （mp4に詰める側が、時刻の巻き戻りを受け付けない）。
    const videoClock = { lastTimestamp: -Infinity };
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];
      const clipOutDuration = (clip.out - clip.in) / clip.speed;
      const detail = `クリップ ${i + 1}/${clips.length}`;

      // 映像と音声を同時に流すと同じ入力ファイルを2か所から読んで遅くなるので、順に処理する。
      framesSubmitted += await writeClipVideo({
        videoSink, videoSource, clip, cursor, totalOut, onProgress, checkCanceled, detail, videoClock,
      });

      if (audioSink && audioWriter) {
        await audioWriter.writeClip({ audioSink, clip, cursor, checkCanceled });
      }

      cursor += clipOutDuration;
    }
    await audioWriter?.flush();

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
      framesSubmitted,
      packetsEncoded,
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

/**
 * 1クリップぶんの映像を、出力時刻に並べ直して書き込む。
 *
 * `videoClock` はクリップをまたいで共有する。mp4に詰める側は時刻の巻き戻りを
 * 受け付けないので、クリップの切れ目で前のクリップの最後のフレームを
 * 追い越さないことを保証する必要がある。
 *
 * @returns {Promise<number>} 実際に投入したフレーム数
 */
async function writeClipVideo({
  videoSink, videoSource, clip, cursor, totalOut, onProgress, checkCanceled, detail, videoClock,
}) {
  let submitted = 0;
  let isFirstFrameOfClip = true;

  for await (const sample of videoSink.samples(clip.in, clip.out)) {
    try {
      checkCanceled();

      // samples() は clip.in をまたぐフレームから返すので、クリップの頭で切り詰める。
      const srcStart = Math.max(sample.timestamp, clip.in);
      const srcEnd = Math.min(sample.timestamp + sample.duration, clip.out);
      if (srcEnd <= srcStart) continue;

      let timestamp = cursor + (srcStart - clip.in) / clip.speed;
      // 可変フレームレートや切れ目の丸めで詰まっても、必ず前へ進める。
      if (timestamp <= videoClock.lastTimestamp) timestamp = videoClock.lastTimestamp + MIN_FRAME_STEP;
      videoClock.lastTimestamp = timestamp;

      sample.setTimestamp(timestamp);
      sample.setDuration((srcEnd - srcStart) / clip.speed);

      /*
       * クリップの1フレーム目は必ずキーフレームにする。
       *
       * クリップの切れ目は映像が突然変わるため、放っておくとエンコーダが
       * 「シーンチェンジだ」と判断して自前でキーフレームを挿し込む。
       * 自前で挿し込まれたキーフレームは前後のフレームの並べ替え（Bフレーム）を
       * 閉じないので、表示順で前に位置するフレームがキーフレームより後に出てきて、
       * mp4に詰める側の「直前のキーフレームより前の時刻は入れられない」検査に
       * 引っかかる（実機のSafari/H.264で発生。クリップが増えるほど当たりやすい）。
       *
       * こちらから明示的に要求したキーフレームは、それより前のフレームを
       * すべて出し切ってから作られるので、並べ替えが切れ目をまたがない。
       * カット位置の画質が上がる副次効果もある。
       */
      await videoSource.add(sample, isFirstFrameOfClip ? { keyFrame: true } : undefined);
      isFirstFrameOfClip = false;
      submitted += 1;

      if (totalOut > 0) {
        onProgress({ phase: 'encode', ratio: Math.min(0.98, timestamp / totalOut), detail });
      }
    } finally {
      sample.close();
    }
  }
  return submitted;
}

/**
 * 1クリップぶんの音声を、速度ぶんリサンプルして書き込む。
 *
 * 出力の時刻は「書き込んだフレーム数 ÷ サンプルレート」で決める（仕様の
 * 「タイムスタンプを音声基準で振り直す」）。クリップの頭では名目の位置へ吸着させ、
 * クリップをまたぐ誤差が溜まらないようにする。
 */
class AudioOutputWriter {
  /**
   * @param {object} p
   * @param {import('../../vendor/mediabunny.min.mjs').AudioSampleSource} p.audioSource
   * @param {number} p.channels
   * @param {number} p.sampleRate
   * @param {ReturnType<typeof createEffectChain> | null} p.effectChain
   */
  constructor({ audioSource, channels, sampleRate, effectChain }) {
    this.audioSource = audioSource;
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.effectChain = effectChain;
    /** 出力タイムライン上の、次に書き込むフレーム位置。 */
    this.frameCursor = 0;
    /** @type {Float32Array[]} まだ書き出していない端数 */
    this.buffered = Array.from({ length: channels }, () => new Float32Array(0));
  }

  /** 1クリップぶんを読み、速度ぶんリサンプルして書き込む。 */
  async writeClip({ audioSink, clip, cursor, checkCanceled }) {
    const resampler = new LinearResampler(this.channels, clip.speed);
    // クリップの頭で名目の位置へ吸着させ、クリップをまたぐ誤差が溜まらないようにする。
    this.frameCursor = Math.round(cursor * this.sampleRate);

    for await (const sample of audioSink.samples(clip.in, clip.out)) {
      try {
        checkCanceled();
        const planes = extractPlanes(sample, this.channels);
        const trimmed = trimToRange(planes, sample, clip, this.sampleRate);
        if (trimmed[0].length === 0) continue;
        await this.#push(resampler.push(trimmed), false);
      } finally {
        sample.close();
      }
    }
    await this.#push(resampler.flush(), false);
  }

  /** 最後に残った端数を書き出す。 */
  async flush() {
    await this.#push(
      Array.from({ length: this.channels }, () => new Float32Array(0)),
      true,
    );
  }

  async #push(planes, force) {
    this.buffered = planes.map((plane, ch) => concat(this.buffered[ch], plane));
    while (this.buffered[0].length >= (force ? 1 : AUDIO_CHUNK_FRAMES)) {
      const take = Math.min(AUDIO_CHUNK_FRAMES, this.buffered[0].length);

      // エフェクトは「速度変更まで済ませた出力タイムライン」に対してかける。
      // フィルターやコンプレッサーは状態を持つので、鎖はクリップをまたいで1本。
      const block = [];
      for (let ch = 0; ch < this.channels; ch += 1) {
        block.push(this.buffered[ch].slice(0, take));
        this.buffered[ch] = this.buffered[ch].slice(take);
      }
      this.effectChain?.process(block, this.frameCursor);

      const interleavedPlanar = new Float32Array(take * this.channels);
      for (let ch = 0; ch < this.channels; ch += 1) {
        interleavedPlanar.set(block[ch], ch * take);
      }
      const audioSample = new AudioSample({
        data: interleavedPlanar,
        format: 'f32-planar',
        numberOfChannels: this.channels,
        sampleRate: this.sampleRate,
        timestamp: this.frameCursor / this.sampleRate,
      });
      this.frameCursor += take;
      try {
        await this.audioSource.add(audioSample);
      } finally {
        audioSample.close();
      }
    }
  }
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
