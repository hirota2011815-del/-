/**
 * dBレベルメーター（Canvas直描き）。
 *
 * 縦バーでRMSとピークを表示し、ピークホールドの位置に横線、
 * -0.6dB到達でCLIPランプを点灯する。プレビューの右に細く並べる想定。
 */
import { DB_CEILING, GRID_DB_LINES, HOT_THRESHOLD_DB, dbToY } from '../audio/dbscale.js';

const COLORS = {
  background: '#12151c',
  track: '#1d222d',
  rms: '#6fb0ff',
  rmsHot: '#ff8a5c',
  peakHold: '#ffffff',
  clipOn: '#ff5c5c',
  clipOff: '#3a2a2e',
  gridLine: 'rgba(207,214,228,0.18)',
};

export class MeterView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pixelRatio = 1;
    this.width = 0;
    this.height = 0;
    /** 表示するチャンネル数（1 or 2）。動画を開いたときに決める。 */
    this.channels = 1;
    /** 直近に読んだレベル。再生していない間はnullで、静止した見た目にする。 */
    this.levels = null;

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => this.resize());
  }

  setChannelCount(channels) {
    this.channels = Math.max(1, Math.min(2, channels || 1));
    this.draw();
  }

  /** @param {{rmsDb: number, peakDb: number, holdDb: number, clip: boolean}[] | null} levels */
  setLevels(levels) {
    this.levels = levels;
    this.draw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.pixelRatio);
    this.canvas.height = Math.round(rect.height * this.pixelRatio);
    this.draw();
  }

  draw() {
    const { ctx, width: w, height: h } = this;
    if (w === 0 || h === 0) return;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    // CLIPランプの分だけ下に確保し、残りをメーター本体にする。
    const lampHeight = 14;
    const meterHeight = Math.max(0, h - lampHeight - 4);

    const gap = 3;
    const barWidth = (w - gap * (this.channels + 1)) / this.channels;
    const anyClip = this.levels?.some((l) => l.clip) ?? false;

    // dBグリッド線（メーター本体の範囲にだけ引く）
    ctx.strokeStyle = COLORS.gridLine;
    ctx.lineWidth = 1;
    for (const db of GRID_DB_LINES) {
      const y = Math.round(dbToY(db, meterHeight)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    for (let ch = 0; ch < this.channels; ch += 1) {
      const x = gap + ch * (barWidth + gap);
      const level = this.levels?.[ch];

      ctx.fillStyle = COLORS.track;
      ctx.fillRect(x, 0, barWidth, meterHeight);

      if (level) {
        const rmsY = dbToY(level.rmsDb, meterHeight);
        ctx.fillStyle = level.rmsDb > HOT_THRESHOLD_DB ? COLORS.rmsHot : COLORS.rms;
        ctx.fillRect(x, rmsY, barWidth, meterHeight - rmsY);

        const holdY = dbToY(level.holdDb, meterHeight);
        ctx.fillStyle = COLORS.peakHold;
        ctx.fillRect(x, holdY, barWidth, 2);
      }
    }

    // 0dBの上端ライン
    const ceilingY = Math.round(dbToY(DB_CEILING, meterHeight)) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, ceilingY);
    ctx.lineTo(w, ceilingY);
    ctx.stroke();

    // CLIPランプ
    const lampY = h - lampHeight;
    ctx.fillStyle = anyClip ? COLORS.clipOn : COLORS.clipOff;
    ctx.fillRect(2, lampY, w - 4, lampHeight - 2);
    ctx.fillStyle = COLORS.gridLine;
    ctx.font = '8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = anyClip ? '#3a0d0d' : '#8d97ab';
    ctx.fillText('CLIP', w / 2, lampY + (lampHeight - 2) / 2 + 1);
    ctx.textAlign = 'left';
  }
}
