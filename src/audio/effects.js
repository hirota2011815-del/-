/**
 * 「音の仕上げ」5つのトグルと、その中身の定数。
 *
 * 画面には専門用語を出さず、押すだけで効くトグルとして見せる。
 * ここはその対応表と、書き出し用のエフェクト鎖の組み立て。
 *
 * ## 接続順について（仕様からの変更点）
 * 仕様の接続順は「ハイパス→ピーキングEQ→コンプレッサー→リミッター→ゲイン→フェード」
 * だが、「音量をそろえる」のゲインは普通プラスの値（例 +4.2dB）になるため、
 * リミッターの後ろに置くと、せっかく-1.5dBで抑えた音をまた押し上げてしまい
 * 「音割れを防ぐ」というリミッター自身の目的を打ち消す。
 * そこでゲインだけ鎖の先頭へ移し、リミッターを最終段にしている。
 * 順序: ゲイン → ハイパス → ピーキングEQ → コンプレッサー → リミッター → フェード
 */
import { aggregateRange, amplitudeToDb } from './dbscale.js';
import { Biquad, Compressor, FadeEnvelope, Gain, highpassCoefficients, peakingCoefficients } from './dsp.js';

/** 各エフェクトの中身（仕様の数値をそのまま持つ）。 */
export const EFFECT_PARAMS = {
  /** 「音量をそろえる」でピークを合わせる先。 */
  normalizeTargetDb: -3,
  /**
   * 自動計算した補正量の上下限。
   * ほぼ無音の素材で際限なく増幅してノイズだけを持ち上げないための歯止めで、
   * ふつうに小さく録れてしまった音（ピーク-33dB程度まで）は上限に当たらず
   * 狙いどおり-3dBまで持ち上がる。
   */
  normalizeMinDb: -12,
  normalizeMaxDb: 30,

  /** 「声をはっきりさせる」 */
  clarityCompressor: { thresholdDb: -26, ratio: 3, kneeDb: 30, attackSec: 0.003, releaseSec: 0.25 },
  clarityPeaking: { freqHz: 3000, q: 1, gainDb: 3.5 },

  /** 「ノイズを減らす」 */
  highpassHz: 110,

  /** 「音割れを防ぐ」 */
  limiter: { thresholdDb: -1.5, ratio: 20, kneeDb: 0, attackSec: 0.001, releaseSec: 0.05 },

  /** 「出だしと終わりをなめらかに」 */
  fadeInSec: 0.5,
  fadeOutSec: 0.6,
};

/** 初期状態。仕様どおり「ノイズを減らす」だけ初期OFF。 */
export function defaultAudioSettings() {
  return {
    normalize: true,
    normalizeGainDb: 0, // 波形から自動計算して入れる
    clarity: true,
    highpassHz: 0, // 0 なら無効。ONで EFFECT_PARAMS.highpassHz が入る
    limiterDb: EFFECT_PARAMS.limiter.thresholdDb, // null なら無効
    fade: true,
  };
}

/**
 * 画面に出す5つのトグル。専門用語は出さず、何が起きるかだけ書く。
 * `get` / `set` で editList.audio との読み書きを閉じ込める。
 */
export const EFFECT_TOGGLES = [
  {
    id: 'normalize',
    label: '音量をそろえる',
    hint: '小さすぎ・大きすぎを直して聞きやすい音量にする',
    get: (audio) => audio.normalize,
    set: (audio, on) => ({ ...audio, normalize: on }),
  },
  {
    id: 'clarity',
    label: '声をはっきりさせる',
    hint: '声が引っ込んで聞こえるときに',
    get: (audio) => audio.clarity,
    set: (audio, on) => ({ ...audio, clarity: on }),
  },
  {
    id: 'denoise',
    label: 'ノイズを減らす',
    hint: 'エアコンや風の低いゴーという音を削る',
    get: (audio) => audio.highpassHz > 0,
    set: (audio, on) => ({ ...audio, highpassHz: on ? EFFECT_PARAMS.highpassHz : 0 }),
  },
  {
    id: 'limiter',
    label: '音割れを防ぐ',
    hint: '大きい音が来ても上限で止める',
    get: (audio) => audio.limiterDb !== null,
    set: (audio, on) => ({ ...audio, limiterDb: on ? EFFECT_PARAMS.limiter.thresholdDb : null }),
  },
  {
    id: 'fade',
    label: '出だしと終わりをなめらかに',
    hint: '頭と終わりの音がブツッと切れないようにする',
    get: (audio) => audio.fade,
    set: (audio, on) => ({ ...audio, fade: on }),
  },
];

/**
 * 「音量をそろえる」の補正量を、解析済みの波形から計算する。
 * 出力に含まれるクリップの範囲だけを見て、その中の最大ピークが
 * -3dB になる補正量を返す。
 *
 * @param {{peaks: Float32Array, rms: Float32Array, sampleRate: number, bucketFrames: number} | null} waveform
 * @param {{in: number, out: number, enabled: boolean}[]} clips
 * @returns {number} dB。波形が無い・全部無音なら 0。
 */
export function computeNormalizeGainDb(waveform, clips) {
  if (!waveform || waveform.peaks.length === 0) return 0;
  const { peaks, rms, sampleRate, bucketFrames } = waveform;

  let maxPeak = 0;
  for (const clip of clips) {
    if (clip.enabled === false) continue;
    const { peak } = aggregateRange(peaks, rms, sampleRate, bucketFrames, clip.in, clip.out);
    if (peak > maxPeak) maxPeak = peak;
  }
  if (maxPeak <= 0) return 0;

  const gainDb = EFFECT_PARAMS.normalizeTargetDb - amplitudeToDb(maxPeak);
  const clamped = Math.min(EFFECT_PARAMS.normalizeMaxDb, Math.max(EFFECT_PARAMS.normalizeMinDb, gainDb));
  return Math.round(clamped * 10) / 10;
}

/** どれか1つでも効いているか（何もONでなければ処理ごと省ける）。 */
export function hasAnyEffect(audio) {
  return Boolean(
    (audio.normalize && audio.normalizeGainDb !== 0) ||
      audio.clarity ||
      audio.highpassHz > 0 ||
      audio.limiterDb !== null ||
      audio.fade,
  );
}

/**
 * 書き出し用のエフェクト鎖を組み立てる。
 * 出力タイムライン上の音声（速度変更を適用した後）に対して、先頭から順に流す。
 *
 * @param {object} p
 * @param {number} p.sampleRate
 * @param {number} p.channels
 * @param {object} p.audio editList.audio
 * @param {number} p.totalDurationSec 出力全体の長さ（フェードアウトの位置決めに使う）
 */
export function createEffectChain({ sampleRate, channels, audio, totalDurationSec }) {
  const stages = [];

  if (audio.normalize && audio.normalizeGainDb !== 0) {
    stages.push(new Gain(audio.normalizeGainDb));
  }
  if (audio.highpassHz > 0) {
    stages.push(new Biquad(highpassCoefficients(audio.highpassHz, sampleRate), channels));
  }
  if (audio.clarity) {
    const { freqHz, q, gainDb } = EFFECT_PARAMS.clarityPeaking;
    stages.push(new Biquad(peakingCoefficients(freqHz, sampleRate, q, gainDb), channels));
    stages.push(new Compressor({ sampleRate, ...EFFECT_PARAMS.clarityCompressor }));
  }
  if (audio.limiterDb !== null) {
    stages.push(new Compressor({ sampleRate, ...EFFECT_PARAMS.limiter, thresholdDb: audio.limiterDb }));
  }

  const fade = audio.fade
    ? new FadeEnvelope({
        sampleRate,
        totalFrames: Math.round(totalDurationSec * sampleRate),
        fadeInSec: EFFECT_PARAMS.fadeInSec,
        fadeOutSec: EFFECT_PARAMS.fadeOutSec,
      })
    : null;

  return {
    /**
     * @param {Float32Array[]} planes チャンネルごとの出力（その場で書き換える）
     * @param {number} startFrame このブロックの先頭が出力全体の何フレーム目か
     *   （クリップの頭で位置を吸着させるので、呼び出し側の値をそのまま使う）
     */
    process(planes, startFrame) {
      if (planes.length === 0 || planes[0].length === 0) return;
      for (const stage of stages) stage.process(planes);
      if (fade) fade.process(planes, startFrame);
    },
  };
}
