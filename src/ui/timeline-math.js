/**
 * タイムラインの座標計算（ズーム・パン・当たり判定）。
 *
 * DOMやCanvasに依存しない純粋関数だけを集めてある。
 * ピンチ操作は「前回の指の中間点の時刻が、今回の指の中間点のx座標に
 * 来るように viewStart を決め直す」ことでズームとパンを同時に処理する。
 */

/** 表示中の時間窓（viewStart〜viewStart+viewDuration）での時刻→x座標（CSSピクセル）。 */
export function timeToX(viewStart, viewDuration, width, t) {
  return ((t - viewStart) / viewDuration) * width;
}

/** x座標（CSSピクセル）→時刻。 */
export function xToTime(viewStart, viewDuration, width, x) {
  return viewStart + (x / width) * viewDuration;
}

/**
 * 表示窓を全体の長さの中に収める。
 * ズームは [minViewDuration, duration] に、パンは [0, duration - viewDuration] に収める。
 */
export function clampView(viewStart, viewDuration, duration, minViewDuration) {
  const vd = Math.min(duration, Math.max(minViewDuration, viewDuration));
  const vs = Math.min(Math.max(0, viewStart), Math.max(0, duration - vd));
  return { viewStart: vs, viewDuration: vd };
}

/**
 * 2本指の「前回の中間点」から「今回の中間点・今回の指の間隔の変化率」への
 * 移動ぶんだけ、表示窓をズーム＋パンする。
 *
 * @param {number} scaleDelta 今回の指の間隔 ÷ 前回の指の間隔（広がった＝ズームイン）
 */
export function applyPinch({ viewStart, viewDuration, width, duration, minViewDuration, prevMidX, newMidX, scaleDelta }) {
  const timeAtPrevMid = xToTime(viewStart, viewDuration, width, prevMidX);
  const rawViewDuration = viewDuration / Math.max(scaleDelta, 1e-6);
  const newViewDuration = Math.min(duration, Math.max(minViewDuration, rawViewDuration));
  const newViewStart = timeAtPrevMid - (newMidX / width) * newViewDuration;
  return clampView(newViewStart, newViewDuration, duration, minViewDuration);
}

/** 2点間の距離。 */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 2点の中間点。 */
export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * x座標に一番近いハンドルを返す。しきい値を超えていたら null。
 * @param {number} x
 * @param {{edge: 'in'|'out', x: number}[]} handles
 * @param {number} thresholdPx
 */
export function nearestHandle(x, handles, thresholdPx) {
  let best = null;
  let bestDist = Infinity;
  for (const h of handles) {
    const d = Math.abs(h.x - x);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return best && bestDist <= thresholdPx ? best : null;
}
