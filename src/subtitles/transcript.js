/**
 * 文字起こしライブラリの生の結果を、字幕の素に直す。
 *
 * ワーカーから切り離してあるのは、ここだけならブラウザ無しでテストできるため
 * （ワーカーのファイルを読み込むと self.onmessage を書き換えてしまう）。
 */

/**
 * 1区間ぶんの結果を、元動画の時刻に直す。
 *
 * @param {{text?: string, chunks?: {timestamp: [number, number|null], text: string}[]}} result
 * @param {{start: number, end: number}} window この結果が元動画のどこの区間か
 * @returns {{start: number, end: number, text: string}[]}
 */
export function toSegments(result, window) {
  const span = window.end - window.start;
  const chunks = Array.isArray(result?.chunks) && result.chunks.length > 0
    ? result.chunks
    // タイムスタンプが返らなかったときは、区間まるごと1つの字幕として扱う
    : [{ timestamp: [0, span], text: result?.text ?? '' }];

  const out = [];
  for (const chunk of chunks) {
    const text = (chunk?.text ?? '').trim();
    if (!text) continue;

    // 最後のかたまりは終了時刻が null で返ってくることがある。
    // Number(null) は 0 になってしまうので、数に直す前に無いことを見る。
    const rawStart = toNumber(chunk?.timestamp?.[0]);
    const rawEnd = toNumber(chunk?.timestamp?.[1]);
    const start = clamp(rawStart ?? 0, 0, span);
    // 終了時刻が無いときは区間の終わりまで伸ばす
    const end = clamp(rawEnd ?? span, start, span);

    out.push({ start: window.start + start, end: window.start + end, text });
  }
  return out;
}

/** 数として読めるときだけ数を返す（null や undefined は null のまま）。 */
function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 音が入っていない区間に出た字幕を捨てる。
 *
 * Whisperは声が無いところでも、それらしい言葉を作ってしまう（幻聴）。
 * 日本語では「ご視聴ありがとうございました」などが典型で、動画の無音部分に
 * 勝手に現れる。決まり文句の一覧で消す手もあるが、本当にそう喋っている動画で
 * 消えてしまうので採らない。
 *
 * 代わりに **その時間に実際に音が入っていたか** を測って判断する。
 * 文字起こしに渡した音声がそのまま手元にあるので、追加のデコードは要らない。
 *
 * @param {{start:number,end:number,text:string}[]} segments 元動画の時刻に直した結果
 * @param {Float32Array} audio その区間の音声（16kHzモノラル）
 * @param {number} windowStart その音声が元動画の何秒目から始まるか
 * @param {number} sampleRate
 * @param {number} thresholdDb これを下回る区間は「喋っていない」とみなす
 */
export function dropQuietSegments(segments, audio, windowStart, sampleRate, thresholdDb = -45) {
  const threshold = 10 ** (thresholdDb / 20);
  return segments.filter((seg) => {
    const from = Math.max(0, Math.round((seg.start - windowStart) * sampleRate));
    const to = Math.min(audio.length, Math.round((seg.end - windowStart) * sampleRate));
    if (to <= from) return false;

    let sumSquares = 0;
    for (let i = from; i < to; i += 1) sumSquares += audio[i] * audio[i];
    return Math.sqrt(sumSquares / (to - from)) >= threshold;
  });
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
