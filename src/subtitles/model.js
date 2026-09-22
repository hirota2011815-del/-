/**
 * 字幕のデータ操作。
 *
 * 時刻は **元動画の時刻** で持つ。文字起こしは元動画の音声に対して行うし、
 * あとからカットし直しても字幕が言葉に貼り付いたままになるため。
 * 書き出しのときに「このフレームは元動画の何秒目か」から引き当てる。
 *
 * DOM非依存の純粋関数だけなので、Nodeでそのままテストできる。
 */

/** これより短い字幕は作らない（秒）。 */
export const MIN_SUBTITLE_DURATION = 0.2;

let idCounter = 0;
function newSubtitleId() {
  idCounter += 1;
  return `s${idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/** @returns {{id: string, start: number, end: number, text: string}} */
export function createSubtitle(start, end, text = '') {
  return { id: newSubtitleId(), start, end, text };
}

/** 時刻順に並べ直す（表示も引き当ても順番が前提）。 */
export function sortSubtitles(subtitles) {
  return [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** 1つ足して、時刻順に並べ直したものを返す。 */
export function addSubtitle(subtitles, subtitle) {
  return sortSubtitles([...subtitles, subtitle]);
}

/**
 * テキストや時刻を書き換える。start/end は前後が入れ替わらないように整える。
 * @param {object} patch {text?, start?, end?}
 */
export function updateSubtitle(subtitles, id, patch, duration = Infinity) {
  const next = subtitles.map((s) => {
    if (s.id !== id) return s;

    const merged = { ...s, ...patch };
    let start = clamp(Number(merged.start), 0, duration);
    let end = clamp(Number(merged.end), 0, duration);
    if (!Number.isFinite(start)) start = s.start;
    if (!Number.isFinite(end)) end = s.end;

    // 片方だけ動かしたときに追い越さないよう、動かした側はそのままにして反対側を押し出す。
    // 押し出した先が動画の端に当たったときだけ、動かした側も戻す。
    if (end - start < MIN_SUBTITLE_DURATION) {
      if (patch.start !== undefined) {
        end = start + MIN_SUBTITLE_DURATION;
        if (end > duration) {
          end = duration;
          start = Math.max(0, end - MIN_SUBTITLE_DURATION);
        }
      } else {
        start = end - MIN_SUBTITLE_DURATION;
        if (start < 0) {
          start = 0;
          end = Math.min(duration, MIN_SUBTITLE_DURATION);
        }
      }
    }
    return { ...merged, start, end };
  });
  return sortSubtitles(next);
}

export function removeSubtitle(subtitles, id) {
  return subtitles.filter((s) => s.id !== id);
}

/**
 * その時刻に出ている字幕を返す。重なっていたら先に始まったほうを採る
 * （1行だけ焼き込む前提なので、必ず1つに決める）。
 * @param {number} sourceTime 元動画の時刻
 */
export function subtitleAt(subtitles, sourceTime) {
  let found = null;
  for (const s of subtitles) {
    if (sourceTime >= s.start && sourceTime < s.end) {
      if (!found || s.start < found.start) found = s;
    }
  }
  return found;
}

/**
 * 文字起こしの結果（{start, end, text}の並び）を字幕に変換する。
 * 空文字や潰れた区間は捨て、重なりは詰めて整える。
 */
export function subtitlesFromTranscript(segments, duration = Infinity) {
  const cleaned = [];
  for (const seg of segments) {
    const text = (seg.text ?? '').trim();
    if (!text) continue;
    const start = clamp(seg.start, 0, duration);
    const end = clamp(seg.end, 0, duration);
    if (end - start < MIN_SUBTITLE_DURATION) continue;

    // 直前と重なっていたら、直前の終わりを手前で止める
    const prev = cleaned.at(-1);
    if (prev && start < prev.end) prev.end = Math.max(prev.start + MIN_SUBTITLE_DURATION, start);
    cleaned.push(createSubtitle(start, end, text));
  }
  return sortSubtitles(cleaned);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
