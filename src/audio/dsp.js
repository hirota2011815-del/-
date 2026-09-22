/**
 * 音声エフェクトの中身（DOM・Web Audio非依存の素のDSP）。
 *
 * 書き出しはWeb Workerの中で走り、WorkerにはWeb Audio APIが無い。
 * そのため「Web Audio APIの標準ノードと同じ構成」をこちらで組み直している。
 * どれも1フレームずつ状態を持って進む逐次処理なので、長尺でも
 * 音声全体をメモリに載せる必要がない。
 *
 * ここは純粋な計算だけなのでNodeでそのままユニットテストできる。
 */

/** dB → 振幅。 */
export function dbToGain(db) {
  return 10 ** (db / 20);
}

/** 振幅 → dB。0以下は十分小さい値として扱う。 */
export function gainToDb(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -200;
}

/* ---- Biquadフィルター（RBJ Audio EQ Cookbook） ------------------------- */

/** ハイパス（低い音を削る）の係数。 */
export function highpassCoefficients(freqHz, sampleRate, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** ピーキングEQ（ある高さだけを持ち上げ／下げる）の係数。 */
export function peakingCoefficients(freqHz, sampleRate, q, gainDb) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/**
 * Biquadフィルター本体。チャンネルごとに遅延（z-1, z-2）を保持する。
 * Direct Form I。
 */
export class Biquad {
  constructor(coefficients, channels) {
    this.c = coefficients;
    this.x1 = new Float64Array(channels);
    this.x2 = new Float64Array(channels);
    this.y1 = new Float64Array(channels);
    this.y2 = new Float64Array(channels);
  }

  /** チャンネルごとの Float32Array をその場で書き換える。 */
  process(planes) {
    const { b0, b1, b2, a1, a2 } = this.c;
    for (let ch = 0; ch < planes.length; ch += 1) {
      const data = planes[ch];
      let x1 = this.x1[ch];
      let x2 = this.x2[ch];
      let y1 = this.y1[ch];
      let y2 = this.y2[ch];
      for (let i = 0; i < data.length; i += 1) {
        const x0 = data[i];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x0;
        y2 = y1;
        y1 = y0;
        data[i] = y0;
      }
      this.x1[ch] = x1;
      this.x2[ch] = x2;
      this.y1[ch] = y1;
      this.y2[ch] = y2;
    }
  }
}

/* ---- コンプレッサー／リミッター ----------------------------------------- */

/**
 * フィードフォワード型のコンプレッサー。
 * Web Audio の DynamicsCompressorNode に合わせて、ソフトニーと
 * アタック／リリースの時定数を持つ。左右は連動（最大値で検出）させて
 * 定位が揺れないようにする。
 *
 * リミッターも同じ構造で、比を極端に（20:1）してニーを0にしたもの。
 */
export class Compressor {
  /**
   * @param {object} p
   * @param {number} p.sampleRate
   * @param {number} p.thresholdDb ここを超えたぶんを圧縮する
   * @param {number} p.ratio 圧縮比（3なら3:1）
   * @param {number} [p.kneeDb] しきい値付近をなめらかにする幅
   * @param {number} [p.attackSec]
   * @param {number} [p.releaseSec]
   */
  constructor({ sampleRate, thresholdDb, ratio, kneeDb = 30, attackSec = 0.003, releaseSec = 0.25 }) {
    this.threshold = thresholdDb;
    this.ratio = ratio;
    this.knee = kneeDb;
    this.attackCoef = Math.exp(-1 / Math.max(1, attackSec * sampleRate));
    this.releaseCoef = Math.exp(-1 / Math.max(1, releaseSec * sampleRate));
    /** 現在かかっている減衰量（dB、0以上）。 */
    this.reductionDb = 0;
  }

  /** いま何dB下げているか（メーター表示用）。 */
  get currentReductionDb() {
    return this.reductionDb;
  }

  #targetReduction(levelDb) {
    const over = levelDb - this.threshold;
    if (this.knee > 0 && over > -this.knee / 2 && over < this.knee / 2) {
      // ニーの中はなめらかに立ち上げる（2次補間）
      const x = over + this.knee / 2;
      return ((1 - 1 / this.ratio) * x * x) / (2 * this.knee);
    }
    if (over <= 0) return 0;
    return over * (1 - 1 / this.ratio);
  }

  process(planes) {
    const frames = planes[0].length;
    for (let i = 0; i < frames; i += 1) {
      let peak = 0;
      for (let ch = 0; ch < planes.length; ch += 1) {
        const abs = Math.abs(planes[ch][i]);
        if (abs > peak) peak = abs;
      }
      const target = this.#targetReduction(gainToDb(peak));
      // 増える（かかり始める）ときはアタック、戻るときはリリースの速さで追従する
      const coef = target > this.reductionDb ? this.attackCoef : this.releaseCoef;
      this.reductionDb = target + (this.reductionDb - target) * coef;

      const gain = dbToGain(-this.reductionDb);
      for (let ch = 0; ch < planes.length; ch += 1) {
        planes[ch][i] *= gain;
      }
    }
  }
}

/* ---- ゲイン・フェード ---------------------------------------------------- */

/** 一定倍率をかけるだけ。 */
export class Gain {
  constructor(db) {
    this.gain = dbToGain(db);
  }

  process(planes) {
    if (this.gain === 1) return;
    for (const data of planes) {
      for (let i = 0; i < data.length; i += 1) data[i] *= this.gain;
    }
  }
}

/**
 * 出だしと終わりのフェード。出力全体の何フレーム目かを見て倍率を決めるので、
 * クリップをまたいでも位置がずれない。
 */
export class FadeEnvelope {
  /**
   * @param {object} p
   * @param {number} p.sampleRate
   * @param {number} p.totalFrames 出力全体のフレーム数
   * @param {number} p.fadeInSec
   * @param {number} p.fadeOutSec
   */
  constructor({ sampleRate, totalFrames, fadeInSec, fadeOutSec }) {
    this.totalFrames = totalFrames;
    this.inFrames = Math.max(0, Math.round(fadeInSec * sampleRate));
    this.outFrames = Math.max(0, Math.round(fadeOutSec * sampleRate));
  }

  /** @param {number} startFrame このブロックの先頭が出力全体の何フレーム目か */
  process(planes, startFrame) {
    const frames = planes[0].length;
    for (let i = 0; i < frames; i += 1) {
      const pos = startFrame + i;
      let gain = 1;
      if (this.inFrames > 0 && pos < this.inFrames) {
        gain = pos / this.inFrames;
      }
      const fromEnd = this.totalFrames - pos;
      if (this.outFrames > 0 && fromEnd <= this.outFrames) {
        gain = Math.min(gain, Math.max(0, fromEnd / this.outFrames));
      }
      if (gain === 1) continue;
      for (let ch = 0; ch < planes.length; ch += 1) planes[ch][i] *= gain;
    }
  }
}
