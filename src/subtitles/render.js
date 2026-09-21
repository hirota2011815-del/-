/**
 * 字幕を Canvas に描く。
 *
 * プレビューのオーバーレイはCSSで出すが、書き出しはここで映像の上に焼き込む。
 * Worker の OffscreenCanvas でも動かすので、DOM（document / getComputedStyle 等）には触らない。
 * 受け取るのは 2D コンテキストだけ。
 *
 * 折り返しは `measureText` の実測で決める。日本語には単語の切れ目がないので
 * 1文字ずつ詰めていき、行頭に来てはいけない記号（、。」など）だけ手前に引き戻す。
 */

/** 行頭に置かない文字（行末に繰り上げる）。 */
const NO_LINE_START = '、。，．,.!?！？）」』】〉》〕｝〗»’”ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ・：；:;';

/** 行末に置かない文字（次の行へ送る）。 */
const NO_LINE_END = '（「『【〈《〔｛〖«‘“(';

/**
 * 文字列を、指定幅に収まる行の配列にする。
 * 明示的な改行（\n）はそこで必ず折る。
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx font設定済みのコンテキスト
 * @param {string} text
 * @param {number} maxWidth 1行の最大幅（px）
 * @returns {string[]}
 */
export function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    for (const line of wrapParagraph(ctx, paragraph, maxWidth)) lines.push(line);
  }
  return lines;
}

function wrapParagraph(ctx, paragraph, maxWidth) {
  const chars = [...paragraph]; // サロゲートペア（絵文字など）を割らない
  const lines = [];
  let current = '';

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const candidate = current + ch;
    // 1文字でも溢れる場合は諦めて置く（無限ループにしない）
    if (current !== '' && ctx.measureText(candidate).width > maxWidth) {
      const { head, tail } = applyKinsoku(current, ch);
      lines.push(head);
      current = tail + ch;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/**
 * 折り返し位置を禁則で調整する。
 * 次の行の頭が「、」などになるなら、直前の1文字を次の行へ送る。
 * 行末が「「」などになるなら、その1文字も次の行へ送る。
 */
function applyKinsoku(line, nextChar) {
  const chars = [...line];
  if (chars.length < 2) return { head: line, tail: '' };

  const last = chars[chars.length - 1];
  const moveForNextStart = NO_LINE_START.includes(nextChar);
  const moveForLineEnd = NO_LINE_END.includes(last);
  if (!moveForNextStart && !moveForLineEnd) return { head: line, tail: '' };

  return { head: chars.slice(0, -1).join(''), tail: last };
}

/**
 * 描く前に位置と大きさを決める。描画せずに検証できるよう分けてある。
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {ReturnType<import('./styles.js').resolveStyle>} style
 * @param {number} videoWidth
 * @param {number} videoHeight
 */
export function layoutSubtitle(ctx, text, style, videoWidth, videoHeight) {
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;

  const maxWidth = videoWidth * style.maxWidthRatio - style.paddingX * 2;
  const lines = wrapLines(ctx, text, Math.max(1, maxWidth));
  const widths = lines.map((line) => ctx.measureText(line).width);
  const blockHeight = lines.length * style.lineHeight;

  let top;
  if (style.position === 'top') {
    top = style.marginY;
  } else if (style.position === 'middle') {
    top = (videoHeight - blockHeight) / 2;
  } else {
    top = videoHeight - style.marginY - blockHeight;
  }
  // 画面外へはみ出さないようにする（行数が多いときや小さい映像で）
  top = Math.max(style.paddingY, Math.min(top, videoHeight - blockHeight - style.paddingY));

  return {
    lines,
    widths,
    centerX: videoWidth / 2,
    top,
    blockHeight,
    lineHeight: style.lineHeight,
  };
}

/**
 * 字幕を1つ描く。テキストが空なら何もしない。
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {ReturnType<import('./styles.js').resolveStyle>} style resolveStyle() の結果
 * @param {number} videoWidth
 * @param {number} videoHeight
 */
export function drawSubtitle(ctx, text, style, videoWidth, videoHeight) {
  if (!text || !String(text).trim()) return;

  const layout = layoutSubtitle(ctx, text, style, videoWidth, videoHeight);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  /*
   * 背景帯は行ごとに出す（長い行と短い行で帯の幅が変わり、字幕らしく見える）。
   * 帯は半透明なので、行同士が少しでも重なるとそこだけ濃くなる。
   * 重ならないよう1行ぶんぴったりに置き、上下の余白は端の行にだけ足す。
   */
  if (style.background) {
    ctx.fillStyle = style.background;
    const last = layout.lines.length - 1;
    for (let i = 0; i < layout.lines.length; i += 1) {
      if (layout.lines[i] === '') continue;
      const w = layout.widths[i] + style.paddingX * 2;
      const padTop = i === 0 ? style.paddingY : 0;
      const padBottom = i === last ? style.paddingY : 0;
      ctx.fillRect(
        layout.centerX - w / 2,
        layout.top + i * style.lineHeight - padTop,
        w,
        style.lineHeight + padTop + padBottom,
      );
    }
  }

  // 縁取り → 塗り の順。逆にすると縁が文字を侵食する。
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  for (let i = 0; i < layout.lines.length; i += 1) {
    const line = layout.lines[i];
    if (line === '') continue;
    const y = layout.top + i * style.lineHeight + style.lineHeight / 2;
    if (style.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeText(line, layout.centerX, y);
    }
    ctx.fillStyle = style.fill;
    ctx.fillText(line, layout.centerX, y);
  }

  ctx.restore();
}
