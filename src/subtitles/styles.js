/**
 * 字幕の見た目。
 *
 * 配色（文字色＋縁取り＋背景）と書体を組み合わせたプリセットを並べ、
 * 「選ぶだけで整う」形にする。自由なカラーピッカーやフォント追加は持たない。
 *
 * 書体はiOSに最初から入っているものだけを使う。ウェブフォントを読むと
 * 書き出し側（Worker内のOffscreenCanvas）でも同じフォントを読み込ませる必要があり、
 * オフラインで焼き込めなくなるため。
 *
 * ここで決めた1つの定義から、プレビュー用のCSSと焼き込み用のCanvas設定の
 * 両方を作る（2か所に同じ数値を書かないため）。
 */

/** 配色。縁取りと背景帯のどちらを使うかも含めて1セット。 */
export const COLOR_SCHEMES = [
  { id: 'white', label: '白・黒フチ', fill: '#ffffff', stroke: '#000000', background: null },
  { id: 'yellow', label: '黄・黒フチ', fill: '#ffe14d', stroke: '#000000', background: null },
  { id: 'band', label: '白・黒帯', fill: '#ffffff', stroke: null, background: 'rgba(0,0,0,0.66)' },
  { id: 'black', label: '黒・白フチ', fill: '#141414', stroke: '#ffffff', background: null },
  { id: 'red', label: '白・赤フチ', fill: '#ffffff', stroke: '#c0202a', background: null },
  { id: 'aqua', label: '水色・紺フチ', fill: '#bfe9ff', stroke: '#0b2a4a', background: null },
];

/** 書体。iOSに標準で入っているものだけ。 */
export const FONTS = [
  {
    id: 'gothic-bold',
    label: 'ゴシック 太',
    family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    weight: 800,
  },
  {
    id: 'gothic',
    label: 'ゴシック',
    family: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif',
    weight: 600,
  },
  {
    id: 'maru',
    label: '丸ゴシック',
    family: '"Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif',
    weight: 600,
  },
  {
    id: 'mincho',
    label: '明朝',
    family: '"Hiragino Mincho ProN", "YuMincho", serif',
    weight: 600,
  },
];

/** 配色 × 書体 の全組み合わせ（24通り）。 */
export const STYLE_PRESETS = COLOR_SCHEMES.flatMap((scheme) =>
  FONTS.map((font) => ({
    id: `${scheme.id}-${font.id}`,
    label: `${scheme.label} ${font.label}`,
    scheme,
    font,
  })),
);

export const DEFAULT_PRESET_ID = 'white-gothic-bold';

/** 位置は3点。 */
export const POSITIONS = [
  { id: 'top', label: '上' },
  { id: 'middle', label: '中央' },
  { id: 'bottom', label: '下' },
];

/** 大きさは3段階。映像の高さに対する比率で持つ（解像度が変わっても同じ見え方になる）。 */
export const SIZES = [
  { id: 'large', label: '大', ratio: 0.075 },
  { id: 'medium', label: '中', ratio: 0.06 },
  { id: 'small', label: '小', ratio: 0.048 },
];

export function defaultSubtitleStyle() {
  return { preset: DEFAULT_PRESET_ID, position: 'bottom', size: 'medium' };
}

export function findPreset(presetId) {
  return STYLE_PRESETS.find((p) => p.id === presetId) ?? STYLE_PRESETS[0];
}

/**
 * 実際に描くための具体的な数値に落とす。
 * プレビュー（CSS）と焼き込み（Canvas）の両方がこれを使う。
 *
 * @param {{preset: string, position: string, size: string}} style
 * @param {number} videoHeight 映像の高さ（px）
 */
export function resolveStyle(style, videoHeight) {
  const preset = findPreset(style.preset);
  const size = SIZES.find((s) => s.id === style.size) ?? SIZES[1];
  const fontSize = Math.max(10, Math.round(videoHeight * size.ratio));

  return {
    fill: preset.scheme.fill,
    stroke: preset.scheme.stroke,
    background: preset.scheme.background,
    fontFamily: preset.font.family,
    fontWeight: preset.font.weight,
    fontSize,
    // 縁取りは文字の大きさに比例させる（小さい字で太すぎると潰れる）
    strokeWidth: Math.max(2, Math.round(fontSize * 0.14)),
    lineHeight: Math.round(fontSize * 1.32),
    // 背景帯の余白
    paddingX: Math.round(fontSize * 0.42),
    paddingY: Math.round(fontSize * 0.2),
    // 画面端からの距離
    marginY: Math.round(videoHeight * 0.055),
    position: style.position,
    // 1行の最大幅（映像幅に対する比率）。これを超えたら折り返す。
    maxWidthRatio: 0.88,
  };
}

/** プレビューの字幕オーバーレイに当てるCSS。 */
export function toCssText(resolved) {
  const shadow = resolved.stroke
    ? // 縁取りはpaint-orderが効かない環境でも出るよう、影を8方向に置いて代用する
      [
        `-1px -1px 0 ${resolved.stroke}`,
        `1px -1px 0 ${resolved.stroke}`,
        `-1px 1px 0 ${resolved.stroke}`,
        `1px 1px 0 ${resolved.stroke}`,
        `0 2px 3px rgba(0,0,0,0.5)`,
      ].join(', ')
    : '0 2px 3px rgba(0,0,0,0.5)';

  return [
    `color: ${resolved.fill}`,
    `font-family: ${resolved.fontFamily}`,
    `font-weight: ${resolved.fontWeight}`,
    `font-size: ${resolved.fontSize}px`,
    `line-height: ${resolved.lineHeight}px`,
    `text-shadow: ${shadow}`,
    resolved.stroke ? `-webkit-text-stroke: ${Math.round(resolved.strokeWidth / 2)}px ${resolved.stroke}` : '',
    resolved.background ? `background: ${resolved.background}` : '',
    resolved.background ? `padding: ${resolved.paddingY}px ${resolved.paddingX}px` : '',
    `max-width: ${Math.round(resolved.maxWidthRatio * 100)}%`,
  ]
    .filter(Boolean)
    .join('; ');
}
