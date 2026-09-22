/**
 * 編集リスト（非破壊編集のデータ本体）。
 *
 * 元ファイルは一切書き換えない。「どこからどこまでを何倍速で・どんな見た目で
 * 再生するか」だけをここに持ち、プレビューも書き出しもこのリストを読んで行う。
 *
 * 永続化する形（仕様の JSON に `id` / `enabled` を足したもの）:
 *
 *   {
 *     "source": "IMG_0431.mp4",
 *     "clips": [
 *       { "id": "c1", "in": 0.0, "out": 12.4, "speed": 1, "enabled": true, "filter": null }
 *     ],
 *     "audio": { "normalizeGainDb": 0, "highpassHz": 0, "limiterDb": -1.5 },
 *     "subtitles": [ { "id": "s1", "start": 1.2, "end": 3.0, "text": "こんにちは" } ],
 *     "subtitleStyle": { "preset": "white-gothic-bold", "position": "bottom", "size": "medium" },
 *     "markers": [ { "t": 24.0, "label": "要確認" } ]
 *   }
 *
 * `id` はUIがクリップを指すため、`enabled` は「除外しても削除はしない」ため。
 * この2つ以外は仕様の形そのままで、`filter` と `audio` と `markers` は
 * ステップ1では読み書きしないが、後のステップでそのまま使えるよう場所だけ確保してある。
 */

import { defaultAudioSettings } from '../audio/effects.js';
import { MIN_SUBTITLE_DURATION, sortSubtitles } from '../subtitles/model.js';
import { defaultSubtitleStyle, findPreset } from '../subtitles/styles.js';

/** クリップ速度。自由入力にはしない（×2超は声が聞き取れず、×0.5未満は映像がカクつくため）。 */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** これより短いクリップは作らない（秒）。カットとトリムの下限。 */
export const MIN_CLIP_DURATION = 0.05;


let idCounter = 0;
function newClipId() {
  idCounter += 1;
  return `c${idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 動画1本ぶんの、まだ何も切っていない編集リストを作る。 */
export function createEditList(sourceName, duration) {
  return {
    source: sourceName,
    duration,
    clips: [makeClip(0, duration)],
    audio: defaultAudioSettings(),
    // 字幕の時刻は元動画基準。カットし直しても言葉に貼り付いたままになる。
    subtitles: [],
    subtitleStyle: defaultSubtitleStyle(),
    markers: [],
  };
}

function makeClip(inPoint, outPoint, base) {
  return {
    id: newClipId(),
    in: inPoint,
    out: outPoint,
    speed: base ? base.speed : 1,
    enabled: base ? base.enabled : true,
    filter: base && base.filter ? { ...base.filter } : null,
  };
}

/** 出力に含まれるクリップだけを、タイムライン順で返す。 */
export function enabledClips(list) {
  return list.clips.filter((c) => c.enabled && c.out - c.in > 0);
}

/** 書き出したときの長さ（秒）。速度を掛けた後の値。 */
export function outputDuration(list) {
  return enabledClips(list).reduce((sum, c) => sum + (c.out - c.in) / c.speed, 0);
}

/** 元動画の時刻 t を含むクリップ。どのクリップにも入っていなければ null。 */
export function clipAtSourceTime(list, t) {
  return list.clips.find((c) => t >= c.in && t < c.out) ?? null;
}

/**
 * 再生位置でクリップを2つに分割する（「ここでカット」）。
 * 分割点がクリップの端すぎる場合や、どのクリップにも当たらない場合は何もしない。
 * @returns {{list: object, newClipId: string|null}}
 */
export function splitAt(list, t) {
  const index = list.clips.findIndex((c) => t > c.in && t < c.out);
  if (index === -1) return { list, newClipId: null };

  const clip = list.clips[index];
  if (t - clip.in < MIN_CLIP_DURATION || clip.out - t < MIN_CLIP_DURATION) {
    return { list, newClipId: null };
  }

  const left = { ...clip, out: t };
  const right = makeClip(t, clip.out, clip);
  const clips = list.clips.slice();
  clips.splice(index, 1, left, right);
  return { list: { ...list, clips }, newClipId: right.id };
}

/** クリップを出力から外す／戻す。クリップ自体は消さない。 */
export function toggleEnabled(list, id) {
  return mapClip(list, id, (c) => ({ ...c, enabled: !c.enabled }));
}

/** クリップの再生速度を差し替える。SPEEDS にない値は無視する。 */
export function setSpeed(list, id, speed) {
  if (!SPEEDS.includes(speed)) return list;
  return mapClip(list, id, (c) => ({ ...c, speed }));
}

/**
 * クリップ一覧をまるごと入れ替える（無音の自動カットで使う）。
 * 速度と除外はリセットされるので、呼び出し側は元に戻せるようにしておくこと。
 *
 * @param {{in: number, out: number}[]} ranges 時間順に並んだ区間
 */
export function replaceClips(list, ranges) {
  const clips = ranges
    .filter((r) => r.out - r.in >= MIN_CLIP_DURATION)
    .map((r) => makeClip(clamp(r.in, 0, list.duration), clamp(r.out, 0, list.duration)));
  if (clips.length === 0) return list;
  return { ...list, clips };
}

/**
 * クリップの端を直接伸縮する（トリム）。隣接クリップの境界と、動画の全長で止まる。
 * @param {'in'|'out'} edge
 */
export function trimClip(list, id, edge, t) {
  const index = list.clips.findIndex((c) => c.id === id);
  if (index === -1) return list;

  const clip = list.clips[index];
  const prev = list.clips[index - 1];
  const next = list.clips[index + 1];
  const lowerBound = prev ? prev.out : 0;
  const upperBound = next ? next.in : list.duration;

  let value;
  if (edge === 'in') {
    value = clamp(t, lowerBound, clip.out - MIN_CLIP_DURATION);
  } else {
    value = clamp(t, clip.in + MIN_CLIP_DURATION, upperBound);
  }
  if (value === clip[edge]) return list;
  return mapClip(list, id, (c) => ({ ...c, [edge]: value }));
}

function mapClip(list, id, fn) {
  const clips = list.clips.map((c) => (c.id === id ? fn(c) : c));
  return { ...list, clips };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ---- タイムラインの時刻変換 -------------------------------------------- */

/**
 * 元動画の時刻 → 書き出し後の時刻。
 * 除外されたクリップの中の時刻は、その手前までの長さを返す。
 */
export function sourceTimeToOutput(list, sourceTime) {
  let acc = 0;
  for (const clip of list.clips) {
    if (!clip.enabled) {
      if (sourceTime < clip.out) return acc;
      continue;
    }
    if (sourceTime < clip.in) return acc;
    if (sourceTime < clip.out) return acc + (sourceTime - clip.in) / clip.speed;
    acc += (clip.out - clip.in) / clip.speed;
  }
  return acc;
}

/** 書き出し後の時刻 → 元動画の時刻。 */
export function outputTimeToSource(list, outputTime) {
  let acc = 0;
  for (const clip of enabledClips(list)) {
    const span = (clip.out - clip.in) / clip.speed;
    if (outputTime < acc + span) return clip.in + (outputTime - acc) * clip.speed;
    acc += span;
  }
  const last = enabledClips(list).at(-1);
  return last ? last.out : 0;
}

/* ---- 保存と復元 --------------------------------------------------------- */

const STORAGE_PREFIX = 'mobile-video-editor:editlist:';

/**
 * 保存キー。同じ端末で同じ動画を開き直したときに続きから編集できるよう、
 * ファイル名・サイズ・更新日時から作る（中身は読まない）。
 */
export function storageKey(file) {
  return `${STORAGE_PREFIX}${file.name}:${file.size}:${file.lastModified}`;
}

/** 仕様どおりの JSON 表現。 */
export function toJSON(list) {
  return {
    source: list.source,
    duration: list.duration,
    clips: list.clips.map((c) => ({
      id: c.id,
      in: round(c.in),
      out: round(c.out),
      speed: c.speed,
      enabled: c.enabled,
      filter: c.filter,
    })),
    audio: { ...list.audio },
    subtitles: (list.subtitles ?? []).map((s) => ({
      id: s.id,
      start: round(s.start),
      end: round(s.end),
      text: s.text,
    })),
    subtitleStyle: { ...(list.subtitleStyle ?? defaultSubtitleStyle()) },
    markers: list.markers.map((m) => ({ t: round(m.t), label: m.label })),
  };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

export function save(list, key) {
  try {
    localStorage.setItem(key, JSON.stringify(toJSON(list)));
    return true;
  } catch {
    // プライベートブラウズや容量超過では黙って諦める。編集自体は続けられる。
    return false;
  }
}

/** 保存済みの編集リストを読む。壊れていたり長さが合わなければ null。 */
export function load(key, duration) {
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data.clips) || data.clips.length === 0) return null;
    const clips = data.clips
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id : newClipId(),
        in: clamp(Number(c.in), 0, duration),
        out: clamp(Number(c.out), 0, duration),
        speed: SPEEDS.includes(c.speed) ? c.speed : 1,
        enabled: c.enabled !== false,
        filter: c.filter ?? null,
      }))
      .filter((c) => Number.isFinite(c.in) && Number.isFinite(c.out) && c.out - c.in >= MIN_CLIP_DURATION);
    if (clips.length === 0) return null;

    return {
      source: data.source ?? '',
      duration,
      clips,
      audio: { ...defaultAudioSettings(), ...(data.audio ?? {}) },
      subtitles: loadSubtitles(data.subtitles, duration),
      subtitleStyle: loadSubtitleStyle(data.subtitleStyle),
      markers: Array.isArray(data.markers) ? data.markers : [],
    };
  } catch {
    return null;
  }
}

/** 保存済みの字幕。壊れた行は落として、残りは活かす。 */
function loadSubtitles(raw, duration) {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((s) => ({
      // idが欠けていたらクリップ用の採番を借りる（種類は違うが、要るのは一意性だけ）
      id: typeof s?.id === 'string' ? s.id : newClipId(),
      start: clamp(Number(s?.start), 0, duration),
      end: clamp(Number(s?.end), 0, duration),
      text: typeof s?.text === 'string' ? s.text : '',
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= MIN_SUBTITLE_DURATION);
  return sortSubtitles(cleaned);
}

/** 保存済みの見た目。知らない値が入っていたら既定に戻す。 */
function loadSubtitleStyle(raw) {
  const base = defaultSubtitleStyle();
  if (!raw || typeof raw !== 'object') return base;
  return {
    preset: findPreset(raw.preset).id,
    position: ['top', 'middle', 'bottom'].includes(raw.position) ? raw.position : base.position,
    size: ['large', 'medium', 'small'].includes(raw.size) ? raw.size : base.size,
  };
}

export function clearSaved(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 消せなくても困らない */
  }
}
