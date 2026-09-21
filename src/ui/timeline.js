/**
 * タイムライン（Canvas直描き）。
 *
 * 操作:
 *   - タップ / ドラッグ: シーク（ドラッグ中は連続的にスクラブする）
 *   - ピンチ: ズーム＋パン（指の間隔と中間点の両方から同時に計算する）
 *   - 選択中クリップの端をドラッグ: トリム（他のクリップの端は掴めない。
 *     境界がどちらのクリップに属するか曖昧にしないための割り切り）
 *   - ダブルタップ: ズームを全体表示に戻す
 *
 * 座標はすべてCSSピクセルで扱う。Canvasのバッキング解像度だけ
 * devicePixelRatio 分を `ctx.setTransform` でまとめて拡大する。
 *
 * dBスケールの波形はステップ3、マーカーはステップ7でこの上に重ねる。
 */
import { applyPinch, clampView, distance, midpoint, nearestHandle, timeToX, xToTime } from './timeline-math.js';

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
  handle: '#ffffff',
  handleShadow: 'rgba(0,0,0,0.5)',
};

/** ハンドルの当たり判定の半径（CSSピクセル）。指で掴みやすいよう見た目より広くとる。 */
const HANDLE_HIT_PX = 18;
/** タップとみなす移動量の上限（CSSピクセル）。これを超えたらドラッグ扱い。 */
const TAP_MOVE_PX = 8;
/** ダブルタップとみなす間隔（ミリ秒）。 */
const DOUBLE_TAP_MS = 350;

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
    this.width = 0;
    this.height = 0;

    // 表示中の時間窓（ズーム・パンの状態）
    this.viewStart = 0;
    this.viewDuration = 0;
    this.minViewDuration = 1;

    /** @type {Map<number, {x: number, y: number}>} 押されている指の現在位置 */
    this.pointers = new Map();
    this.mode = null; // null | 'seek' | 'trim'
    this.trim = null; // { clipId, edge }
    this.downPoint = null; // タップ判定用の押し始め位置
    this.lastTapAt = 0;
    this.lastTapX = 0;

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.#onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.#onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.#onPointerUp(e));

    const resize = () => this.resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
  }

  setEditList(list) {
    this.list = list;
    this.viewStart = 0;
    this.viewDuration = list ? list.duration : 0;
    this.minViewDuration = list ? Math.max(0.25, Math.min(list.duration, 1)) : 1;
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

  /** 全体表示に戻す（ズーム解除）。 */
  resetZoom() {
    if (!this.list) return;
    this.viewStart = 0;
    this.viewDuration = this.list.duration;
    this.draw();
  }

  /** テスト・デバッグ用。 */
  get viewWindow() {
    return { start: this.viewStart, duration: this.viewDuration };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
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

    if (!this.list || this.list.duration <= 0) return;

    const toX = (t) => timeToX(this.viewStart, this.viewDuration, w, t);

    // 目盛り（表示中の時間窓に合わせて間隔を選ぶ）
    ctx.strokeStyle = COLORS.tick;
    ctx.lineWidth = 1;
    const step = tickStep(this.viewDuration);
    const firstTick = Math.ceil(this.viewStart / step) * step;
    for (let t = firstTick; t < this.viewStart + this.viewDuration; t += step) {
      const x = Math.round(toX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    for (const clip of this.list.clips) {
      const x = toX(clip.in);
      const cw = toX(clip.out) - x;
      if (x + cw < 0 || x > w) continue; // 画面外は描かない
      const selected = clip.id === this.selectedClipId;
      const drawW = Math.max(2, cw);

      ctx.fillStyle = clip.enabled ? (selected ? COLORS.clipSelected : COLORS.clip) : COLORS.clipDisabled;
      ctx.fillRect(x, 0, drawW, h);

      if (!clip.enabled) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, drawW, h);
        ctx.clip();
        ctx.strokeStyle = COLORS.clipDisabledStripe;
        ctx.lineWidth = 2;
        const gap = 10;
        for (let sx = x - h; sx < x + drawW; sx += gap) {
          ctx.beginPath();
          ctx.moveTo(sx, h);
          ctx.lineTo(sx + h, 0);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, 0, drawW, h);

      if (clip.speed !== 1 && drawW > 34) {
        ctx.fillStyle = COLORS.label;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`×${clip.speed}`, x + 5, h - 4);
      }
    }

    // 選択中クリップの端だけ、掴めるハンドルを表示する
    const selectedClip = this.list.clips.find((c) => c.id === this.selectedClipId);
    if (selectedClip) {
      for (const handle of this.#handlesFor(selectedClip)) {
        this.#drawHandle(handle.x);
      }
    }

    const px = Math.round(toX(this.playhead)) + 0.5;
    if (px >= -1 && px <= w + 1) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }

  #drawHandle(x) {
    const { ctx, height: h } = this;
    ctx.save();
    ctx.shadowColor = COLORS.handleShadow;
    ctx.shadowBlur = 3;
    ctx.fillStyle = COLORS.handle;
    ctx.fillRect(x - 1.5, 0, 3, h);
    ctx.beginPath();
    ctx.arc(x, h / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** 選択中クリップの in/out ハンドルの現在のx座標。 */
  #handlesFor(clip) {
    const toX = (t) => timeToX(this.viewStart, this.viewDuration, this.width, t);
    return [
      { edge: 'in', x: toX(clip.in) },
      { edge: 'out', x: toX(clip.out) },
    ];
  }

  #localPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  #onPointerDown(event) {
    if (!this.list || this.list.duration <= 0) return;
    event.preventDefault();
    // ブラウザ・入力経路によっては失敗しうる（例: 合成イベントでのテスト実行時）。
    // キャプチャは「指がcanvas外に出ても追跡し続ける」ための保険なので、失敗しても操作自体は続行する。
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* 無視して続行 */
    }

    const point = this.#localPoint(event);
    this.pointers.set(event.pointerId, point);

    if (this.pointers.size >= 2) {
      this.mode = 'pinch';
      this.trim = null;
      return;
    }

    this.downPoint = point;
    const selectedClip = this.list.clips.find((c) => c.id === this.selectedClipId);
    const handle = selectedClip
      ? nearestHandle(point.x, this.#handlesFor(selectedClip), HANDLE_HIT_PX)
      : null;

    if (handle) {
      this.mode = 'trim';
      this.trim = { clipId: selectedClip.id, edge: handle.edge };
    } else {
      this.mode = 'seek';
      this.#emitSeek(point.x);
    }
  }

  #onPointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      this.#handlePinchMove(event.pointerId, this.#localPoint(event));
      return;
    }

    this.pointers.set(event.pointerId, this.#localPoint(event));
    const point = this.pointers.get(event.pointerId);

    if (this.mode === 'trim' && this.trim) {
      const t = xToTime(this.viewStart, this.viewDuration, this.width, point.x);
      this.dispatchEvent(new CustomEvent('trim', { detail: { ...this.trim, time: t } }));
    } else if (this.mode === 'seek') {
      this.#emitSeek(point.x);
    }
  }

  #handlePinchMove(movedPointerId, newPoint) {
    const ids = [...this.pointers.keys()];
    const other = ids.find((id) => id !== movedPointerId);
    if (other === undefined) return;

    const prevA = this.pointers.get(movedPointerId);
    const prevB = this.pointers.get(other);
    const prevDist = distance(prevA, prevB);
    const prevMid = midpoint(prevA, prevB);

    this.pointers.set(movedPointerId, newPoint);
    const newA = newPoint;
    const newB = this.pointers.get(other);
    const newDist = distance(newA, newB);
    const newMid = midpoint(newA, newB);

    if (prevDist < 1) return; // ゼロ割り回避。指がほぼ重なっているフレームは無視する

    const { viewStart, viewDuration } = applyPinch({
      viewStart: this.viewStart,
      viewDuration: this.viewDuration,
      width: this.width,
      duration: this.list.duration,
      minViewDuration: this.minViewDuration,
      prevMidX: prevMid.x,
      newMidX: newMid.x,
      scaleDelta: newDist / prevDist,
    });
    this.viewStart = viewStart;
    this.viewDuration = viewDuration;
    this.draw();
  }

  #onPointerUp(event) {
    const wasTap =
      this.mode === 'seek' &&
      this.downPoint &&
      this.pointers.has(event.pointerId) &&
      distance(this.downPoint, this.pointers.get(event.pointerId)) < TAP_MOVE_PX;

    this.pointers.delete(event.pointerId);
    try {
      this.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      /* 無視して続行 */
    }

    if (wasTap) this.#checkDoubleTap(this.downPoint.x);

    if (this.pointers.size >= 2) {
      this.mode = 'pinch';
    } else if (this.pointers.size === 1) {
      this.mode = 'seek'; // 2本指の片方を離したら、残った指でスクラブを続けられるようにする
    } else {
      this.mode = null;
      this.trim = null;
    }
    this.downPoint = null;
  }

  #checkDoubleTap(x) {
    const now = performance.now();
    if (now - this.lastTapAt < DOUBLE_TAP_MS && Math.abs(x - this.lastTapX) < 40) {
      this.resetZoom();
      this.lastTapAt = 0;
    } else {
      this.lastTapAt = now;
      this.lastTapX = x;
    }
  }

  #emitSeek(x) {
    const t = xToTime(this.viewStart, this.viewDuration, this.width, x);
    const clamped = Math.min(this.list.duration, Math.max(0, t));
    this.dispatchEvent(new CustomEvent('seek', { detail: { time: clamped } }));
  }
}

function tickStep(viewDuration) {
  for (const candidate of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (viewDuration / candidate <= 12) return candidate;
  }
  return 900;
}
