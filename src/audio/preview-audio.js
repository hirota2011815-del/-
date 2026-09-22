/**
 * プレビュー用の音声グラフ。
 *
 * <video> の音を Web Audio に通し、
 *   ゲイン → ハイパス → ピーキングEQ → コンプレッサー → リミッター
 * の順にエフェクトをかけてからスピーカーへ返す。
 * 同じ地点から分岐させた AnalyserNode で、再生中のdBメーターも読む。
 * つまりメーターが示すのは「エフェクトをかけた後の音」になる。
 *
 * ## 書き出しとの関係
 * 書き出しはWeb Workerの中で走りWeb Audioが使えないため、同じ構成を
 * src/audio/dsp.js に組み直してある。こちらは耳で確かめるための近似で、
 * 実際に出来上がるファイルを決めるのは dsp.js のほう。
 * 数値（しきい値や周波数）は src/audio/effects.js の EFFECT_PARAMS で共有している。
 *
 * フェード（出だしと終わり）は書き出したファイルの頭と尻の話なので、
 * プレビューには入れていない。
 *
 * 注意: <video> に対して createMediaElementSource() を呼べるのは一度きりで、
 * 呼んだ瞬間から既定のスピーカー出力が切れる。鎖の最後を destination へ
 * つなぎ直すことで再生を保つ。
 */
import { CLIP_THRESHOLD_DB, DB_FLOOR, PEAK_HOLD_SEC, amplitudeToDb } from './dbscale.js';
import { EFFECT_PARAMS } from './effects.js';

/** getFloatTimeDomainData で読む窓の大きさ。小さいほど反応が速い。 */
const FFT_SIZE = 1024;

/** 「切っている」ときに素通しにするための値。 */
const BYPASS = {
  highpassHz: 10, // 可聴域より十分下なので実質そのまま通る
  peakingGainDb: 0,
  compressorThresholdDb: 0,
  compressorRatio: 1,
};

export class PreviewAudio {
  /** @param {HTMLMediaElement} mediaElement */
  constructor(mediaElement) {
    this.media = mediaElement;
    this.ctx = null;
    this.nodes = null;
    this.analysers = [];
    this.buffer = null;
    this.peakHold = [];
    /** start() より前に設定されても覚えておく。 */
    this.pendingSettings = null;
  }

  get channelCount() {
    return this.analysers.length;
  }

  /** 初回は必ずユーザー操作（再生ボタンなど）のハンドラ内から呼ぶこと。 */
  async start() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return false;
      this.ctx = new AudioContextClass();

      let source;
      try {
        source = this.ctx.createMediaElementSource(this.media);
      } catch {
        // 既にどこかで作られている等。メーターなしでも再生自体は続けられるようにする。
        this.ctx = null;
        return false;
      }
      this.#buildGraph(source);
      if (this.pendingSettings) this.setSettings(this.pendingSettings);
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* 次の再生開始時にまた試す */
      }
    }
    return true;
  }

  #buildGraph(source) {
    const ctx = this.ctx;

    const gain = ctx.createGain();

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = BYPASS.highpassHz;

    const peaking = ctx.createBiquadFilter();
    peaking.type = 'peaking';
    peaking.frequency.value = EFFECT_PARAMS.clarityPeaking.freqHz;
    peaking.Q.value = EFFECT_PARAMS.clarityPeaking.q;
    peaking.gain.value = BYPASS.peakingGainDb;

    const compressor = ctx.createDynamicsCompressor();
    const limiter = ctx.createDynamicsCompressor();
    for (const node of [compressor, limiter]) {
      node.threshold.value = BYPASS.compressorThresholdDb;
      node.ratio.value = BYPASS.compressorRatio;
    }

    source.connect(gain);
    gain.connect(highpass);
    highpass.connect(peaking);
    peaking.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(ctx.destination);

    // メーターはエフェクトの後から分岐して読む
    const splitter = ctx.createChannelSplitter(2);
    limiter.connect(splitter);
    this.analysers = [0, 1].map(() => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0; // 生の値を見るので平滑化しない
      return analyser;
    });
    splitter.connect(this.analysers[0], 0);
    splitter.connect(this.analysers[1], 1);

    this.nodes = { gain, highpass, peaking, compressor, limiter };
    this.buffer = new Float32Array(FFT_SIZE);
    this.peakHold = [
      { db: DB_FLOOR, at: 0 },
      { db: DB_FLOOR, at: 0 },
    ];
  }

  /**
   * トグルの状態を反映する。OFFのものは鎖から外さず、素通しになる値を入れる
   * （つなぎ替えないので再生中に切り替えてもプツッと途切れない）。
   * @param {object} audio editList.audio
   */
  setSettings(audio) {
    this.pendingSettings = audio;
    if (!this.nodes) return;
    const { gain, highpass, peaking, compressor, limiter } = this.nodes;
    const at = this.ctx.currentTime;

    gain.gain.setTargetAtTime(
      audio.normalize ? 10 ** (audio.normalizeGainDb / 20) : 1,
      at,
      0.01,
    );
    highpass.frequency.setTargetAtTime(audio.highpassHz > 0 ? audio.highpassHz : BYPASS.highpassHz, at, 0.01);
    peaking.gain.setTargetAtTime(
      audio.clarity ? EFFECT_PARAMS.clarityPeaking.gainDb : BYPASS.peakingGainDb,
      at,
      0.01,
    );

    const comp = EFFECT_PARAMS.clarityCompressor;
    compressor.threshold.value = audio.clarity ? comp.thresholdDb : BYPASS.compressorThresholdDb;
    compressor.ratio.value = audio.clarity ? comp.ratio : BYPASS.compressorRatio;
    compressor.knee.value = audio.clarity ? comp.kneeDb : 0;
    compressor.attack.value = comp.attackSec;
    compressor.release.value = comp.releaseSec;

    const lim = EFFECT_PARAMS.limiter;
    const limiterOn = audio.limiterDb !== null;
    limiter.threshold.value = limiterOn ? audio.limiterDb : BYPASS.compressorThresholdDb;
    limiter.ratio.value = limiterOn ? lim.ratio : BYPASS.compressorRatio;
    limiter.knee.value = 0;
    limiter.attack.value = lim.attackSec;
    limiter.release.value = lim.releaseSec;
  }

  /**
   * @returns {{rmsDb: number, peakDb: number, holdDb: number, clip: boolean}[]}
   *   チャンネルごとの現在値。まだ開始していなければ空配列。
   */
  read() {
    if (!this.ctx || this.ctx.state !== 'running') return [];
    const now = performance.now() / 1000;

    return this.analysers.map((analyser, ch) => {
      analyser.getFloatTimeDomainData(this.buffer);
      let sumSquares = 0;
      let peak = 0;
      for (let i = 0; i < this.buffer.length; i += 1) {
        const v = this.buffer[i];
        sumSquares += v * v;
        const abs = v < 0 ? -v : v;
        if (abs > peak) peak = abs;
      }
      const rmsDb = amplitudeToDb(Math.sqrt(sumSquares / this.buffer.length));
      const peakDb = amplitudeToDb(peak);

      const hold = this.peakHold[ch];
      if (peakDb >= hold.db || now - hold.at > PEAK_HOLD_SEC) {
        hold.db = peakDb;
        hold.at = now;
      }

      return { rmsDb, peakDb, holdDb: hold.db, clip: hold.db >= CLIP_THRESHOLD_DB };
    });
  }
}
