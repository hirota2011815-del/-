/**
 * 再生中のリアルタイムdBメーター。
 *
 * <video> にWeb AudioのAnalyserNodeを挿し込み、getFloatTimeDomainData() から
 * RMSとピークを毎フレーム計算する。ピークホールドは「1.1秒間、直近の最大値を
 * 表示し続け、更新が無ければその時点の値へ落ちる」という単純な方式。
 *
 * 注意: <video> に対して createMediaElementSource() を呼べるのは一度きりで、
 * 呼んだ瞬間から既定のスピーカー出力が切れる。再生を聞こえたままにするため、
 * source は明示的に destination にもつなぎ直す。
 */
import { CLIP_THRESHOLD_DB, DB_FLOOR, PEAK_HOLD_SEC, amplitudeToDb } from './dbscale.js';

/** getFloatTimeDomainData で読む窓の大きさ。小さいほど反応が速い。 */
const FFT_SIZE = 1024;

export class LevelMeter {
  /** @param {HTMLMediaElement} mediaElement */
  constructor(mediaElement) {
    this.media = mediaElement;
    this.ctx = null;
    this.analysers = [];
    this.buffer = null;
    this.peakHold = [];
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
        // 別の場所で既に作られている等。メーターなしで再生自体は続けられるようにする。
        this.ctx = null;
        return false;
      }
      source.connect(this.ctx.destination); // 既定の出力が切れる分をつなぎ直す

      const splitter = this.ctx.createChannelSplitter(2);
      source.connect(splitter);

      this.analysers = [0, 1].map(() => {
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0; // 生の値を見るので平滑化しない
        return analyser;
      });
      splitter.connect(this.analysers[0], 0);
      splitter.connect(this.analysers[1], 1);

      this.buffer = new Float32Array(FFT_SIZE);
      this.peakHold = [
        { db: DB_FLOOR, at: 0 },
        { db: DB_FLOOR, at: 0 },
      ];
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
