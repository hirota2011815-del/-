/**
 * 字幕を映像に焼き込む。
 *
 * 書き出しのフレームを1枚ずつCanvasに描き直し、その上に字幕を重ねてから
 * エンコーダに渡す。mp4に「字幕トラック」を入れるやり方は、端末や再生アプリに
 * よって出たり出なかったりするので採らない。
 *
 * ## 縦向きで撮った動画の扱い
 * スマホの縦動画は、ピクセルは横向きのまま「90度回して表示せよ」という指示が
 * mp4のメタデータに入っていることが多い。字幕を入れないときはそのメタデータごと
 * 引き渡しているが、焼き込むときはそうはいかない。寝たままのピクセルに字幕を
 * 描くと、再生時に映像ごと字幕まで回って横倒しになる。
 *
 * そこでここでは **先に起こしてから** 描く。出てくる映像は最初から正しい向きなので、
 * 呼び出し側は「回して表示せよ」のメタデータを付けてはいけない。
 */
import { VideoSample } from '../../vendor/mediabunny.min.mjs';
import { subtitleAt } from '../subtitles/model.js';
import { drawSubtitle } from '../subtitles/render.js';
import { defaultSubtitleStyle, resolveStyle } from '../subtitles/styles.js';

/**
 * @param {object} p
 * @param {{start: number, end: number, text: string}[]} p.subtitles 元動画の時刻で並んだ字幕
 * @param {{preset: string, position: string, size: string}} p.style
 * @param {number} p.codedWidth 元映像のピクセル幅（回す前）
 * @param {number} p.codedHeight 元映像のピクセル高さ（回す前）
 * @param {0|90|180|270} p.rotation 元動画の「回して表示せよ」の角度
 * @param {boolean} p.flip
 */
export function createSubtitleBurner({ subtitles, style, codedWidth, codedHeight, rotation = 0, flip = false }) {
  // 起こしたあとの大きさ。90度・270度なら縦横が入れ替わる。
  const upright = rotation % 180 === 0;
  const width = upright ? codedWidth : codedHeight;
  const height = upright ? codedHeight : codedWidth;

  const canvas = createCanvas(width, height);
  // alpha:false のほうが速く、映像は下地が必ず埋まるので透明は要らない。
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('この端末では字幕を焼き込めません（Canvasを作れませんでした）。');

  // 文字の大きさは映像の高さに対する比率で決まるので、起こしたあとの高さで確定させる。
  const resolved = resolveStyle(style ?? defaultSubtitleStyle(), height);

  return {
    width,
    height,

    /**
     * 1フレーム描いて、エンコーダに渡せる形にして返す。
     * 返ってきたサンプルは呼び出し側が close すること。
     *
     * @param {import('../../vendor/mediabunny.min.mjs').VideoSample} sample 元のフレーム
     * @param {number} sourceTime このフレームは元動画の何秒目か（字幕の引き当てに使う）
     * @param {number} timestamp 出力タイムライン上の時刻（秒）
     * @param {number} duration 出力タイムライン上の長さ（秒）
     */
    paint(sample, sourceTime, timestamp, duration) {
      // 回転はフレームに付いている値ではなくトラックの値を明示的に渡す
      // （デコーダを通ったフレームに回転が残るかは実装依存のため）。
      sample.drawWithFit(ctx, { fit: 'fill', rotation, flip });

      const active = subtitleAt(subtitles, sourceTime);
      if (active) drawSubtitle(ctx, active.text, resolved, width, height);

      return new VideoSample(canvas, { timestamp, duration });
    },
  };
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('この端末では字幕を焼き込めません（Canvasがありません）。');
}
