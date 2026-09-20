/**
 * タイムライン（Canvas直描き）。
 *
 * ステップ1では「クリップの帯 + 再生位置」だけを描く。
 * dBスケールの波形はステップ3、マーカーはステップ7でこの上に重ねる。
 */
const COLORS = {
  background: '#12151c',
  clip: '#2f6fd0',
  clipSelected: '#4f93ff',
  clipDisabled: '#2a2f3a',
  clipDisabledStripe: '#353b49',
  border: '#0b0d12',
  playhead: '#ff5c5c',
  tick: '#39404f',
  label: '#cfd6e4',
};

export class Timeline extends EventTarget {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.list = null;
    this.playhead = 0;
    this.selectedClipId = null;
    this.pixelRatio = 1;

    canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    const resize = () => this.resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
  }

  setEditList(list) {
    this.list = list;
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  setSelected(clipId) {
    this.selectedClipId = clipId;
    this.draw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(rect.width * this.pixelRatio);
    this.canvas.height = Math.round(rect.height * this.pixelRatio);
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, w, h);

    if (!this.list || this.list.duration <= 0) return;

    const duration = this.list.duration;
    const toX = (t) => (t / duration) * w;

    // 10秒ごとの目盛り
    ctx.strokeStyle = COLORS.tick;
    ctx.lineWidth = 1 * this.pixelRatio;
    const step = tickStep(duration);
    for (let t = step; t < duration; t += step) {
      const x = Math.round(toX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    for (const clip of this.list.clips) {
      const x = toX(clip.in);
      const cw = Math.max(2 * this.pixelRatio, toX(clip.out) - x);
      const selected = clip.id === this.selectedClipId;

      ctx.fillStyle = clip.enabled
        ? selected ? COLORS.clipSelected : COLORS.clip
        : COLORS.clipDisabled;
      ctx.fillRect(x, 0, cw, h);

      if (!clip.enabled) {
        // 除外中は斜線を重ねる
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, cw, h);
        ctx.clip();
        ctx.strokeStyle = COLORS.clipDisabledStripe;
        ctx.lineWidth = 2 * this.pixelRatio;
        const gap = 10 * this.pixelRatio;
        for (let sx = x - h; sx < x + cw; sx += gap) {
          ctx.beginPath();
          ctx.moveTo(sx, h);
          ctx.lineTo(sx + h, 0);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 2 * this.pixelRatio;
      ctx.strokeRect(x, 0, cw, h);

      if (clip.speed !== 1 && cw > 34 * this.pixelRatio) {
        ctx.fillStyle = COLORS.label;
        ctx.font = `${11 * this.pixelRatio}px system-ui, sans-serif`;
        ctx.textBaseline = 'bottom';
        ctx.fillText(`×${clip.speed}`, x + 5 * this.pixelRatio, h - 4 * this.pixelRatio);
      }
    }

    const px = Math.round(toX(this.playhead)) + 0.5;
    ctx.strokeStyle = COLORS.playhead;
    ctx.lineWidth = 2 * this.pixelRatio;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }

  #onPointerDown(event) {
    if (!this.list || this.list.duration <= 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const t = Math.min(this.list.duration, Math.max(0, ratio * this.list.duration));
    this.dispatchEvent(new CustomEvent('seek', { detail: { time: t } }));
  }
}

function tickStep(duration) {
  for (const candidate of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (duration / candidate <= 20) return candidate;
  }
  return 900;
}
