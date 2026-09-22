/**
 * 書き出し画質。1080p を基準に、解像度に合わせてビットレートを調整する。
 * （仕様の目安: 1080p で 12 / 6 / 3 Mbps）
 */
export const QUALITY_PRESETS = [
  { id: 'high', label: '高画質', mbpsAt1080p: 12, hint: '重いが綺麗' },
  { id: 'standard', label: '標準', mbpsAt1080p: 6, hint: 'ふだんはこれ' },
  { id: 'light', label: '軽量', mbpsAt1080p: 3, hint: '軽くて送りやすい' },
];

export const DEFAULT_QUALITY = 'standard';

const REFERENCE_PIXELS = 1920 * 1080;

/** 映像のビットレート（bps）。 */
export function videoBitrate(qualityId, width, height) {
  const preset = QUALITY_PRESETS.find((p) => p.id === qualityId) ?? QUALITY_PRESETS[1];
  const pixels = Math.max(1, width * height);
  // 画素数の平方根に比例させる。線形だと低解像度で落としすぎる。
  const scale = Math.sqrt(pixels / REFERENCE_PIXELS);
  const bps = preset.mbpsAt1080p * 1_000_000 * scale;
  return Math.round(Math.min(Math.max(bps, 400_000), 40_000_000));
}

/** 音声のビットレート（bps）。画質選択では変えない。 */
export function audioBitrate(channels) {
  return channels >= 2 ? 128_000 : 96_000;
}

export function qualityLabel(qualityId) {
  return (QUALITY_PRESETS.find((p) => p.id === qualityId) ?? QUALITY_PRESETS[1]).label;
}
