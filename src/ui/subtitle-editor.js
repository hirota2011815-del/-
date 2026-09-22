/**
 * 字幕の編集パネル。
 *
 * スマホの画面に何十行ものテキスト欄を並べると重くて触りにくいので、
 * 編集できるのは **いま再生位置に出ている1行だけ** にしてある。
 * 他の行は一覧から選んでその位置へ飛ぶ（＝編集対象が切り替わる）。
 *
 * 時刻は元動画の時刻で扱う（src/subtitles/model.js を参照）。
 */
import {
  COLOR_SCHEMES,
  FONTS,
  POSITIONS,
  SIZES,
  findPreset,
  resolveStyle,
  toCssText,
} from '../subtitles/styles.js';
import {
  MIN_SUBTITLE_DURATION,
  addSubtitle,
  createSubtitle,
  removeSubtitle,
  subtitleAt,
  updateSubtitle,
} from '../subtitles/model.js';
import { formatTime } from '../core/format.js';

/** 時刻の微調整の刻み（秒）。 */
const NUDGE_SEC = 0.1;

/** 新しく足す字幕の長さ（秒）。 */
const NEW_SUBTITLE_SEC = 2;

export class SubtitlePanel extends EventTarget {
  /**
   * @param {object} dom 各要素（index.html のid）
   */
  constructor(dom) {
    super();
    this.dom = dom;
    this.subtitles = [];
    this.style = null;
    this.duration = 0;
    this.sourceTime = 0;
    this.enabled = false;
    /** いまテキスト欄を出している字幕のid。変わったときだけ欄を作り直す。 */
    this.editingId = null;

    this.#renderStyleChips();
  }

  setState({ subtitles, style, duration, enabled }) {
    this.subtitles = subtitles ?? [];
    this.style = style ?? this.style;
    this.duration = duration ?? this.duration;
    this.enabled = Boolean(enabled);
    this.#renderStyleChips();
    this.#renderCurrent(true);
    this.#renderList();
    this.#renderOverlay();
  }

  /** 再生位置が動いたとき。字幕が変わったときだけ作り直す。 */
  setSourceTime(t) {
    this.sourceTime = t;
    const active = subtitleAt(this.subtitles, t);
    this.#renderOverlay();
    if ((active?.id ?? null) !== this.editingId) {
      this.#renderCurrent(true);
      this.#markActiveRow();
    }
  }

  /* ---- 見た目の選択 ---- */

  #renderStyleChips() {
    const style = this.style;
    if (!style) return;
    const preset = findPreset(style.preset);

    chips(this.dom.schemes, COLOR_SCHEMES, preset.scheme.id, (id) => {
      this.#emitStyle({ preset: `${id}-${preset.font.id}` });
    }, (scheme) => swatch(scheme));

    chips(this.dom.fonts, FONTS, preset.font.id, (id) => {
      this.#emitStyle({ preset: `${preset.scheme.id}-${id}` });
    });

    chips(this.dom.positions, POSITIONS, style.position, (id) => this.#emitStyle({ position: id }));
    chips(this.dom.sizes, SIZES, style.size, (id) => this.#emitStyle({ size: id }));
  }

  #emitStyle(patch) {
    const style = { ...this.style, ...patch };
    this.style = style;
    this.#renderStyleChips();
    this.#renderOverlay();
    this.dispatchEvent(new CustomEvent('stylechange', { detail: { style } }));
  }

  /* ---- プレビューへの重ね表示 ---- */

  #renderOverlay() {
    const { overlay, overlayText, video } = this.dom;
    const active = subtitleAt(this.subtitles, this.sourceTime);
    if (!active || !this.style) {
      overlay.hidden = true;
      return;
    }
    overlay.hidden = false;
    overlay.dataset.position = this.style.position;
    // 文字の大きさは映像の高さに対する比率なので、いま画面に出ている高さで計算する
    // （書き出しでは実際の解像度で計算し直される）。
    const height = video.clientHeight || 180;
    overlayText.textContent = active.text;
    overlayText.style.cssText = toCssText(resolveStyle(this.style, height));
  }

  /* ---- いま出ている字幕 ---- */

  #renderCurrent(rebuild) {
    const box = this.dom.current;
    const active = subtitleAt(this.subtitles, this.sourceTime);
    this.editingId = active?.id ?? null;
    if (!rebuild) return;

    box.replaceChildren();

    if (!active) {
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = 'この位置には字幕がありません。';

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn';
      add.id = 'subtitleAddBtn';
      add.textContent = 'いまの位置に追加';
      add.disabled = !this.enabled;
      add.addEventListener('click', () => this.#addHere());

      box.append(hint, add);
      return;
    }

    const times = document.createElement('div');
    times.className = 'subtitle-times';
    times.append(
      nudgeGroup('始まり', active.start, (delta) => this.#nudge(active.id, 'start', delta), !this.enabled),
      nudgeGroup('終わり', active.end, (delta) => this.#nudge(active.id, 'end', delta), !this.enabled),
    );

    const area = document.createElement('textarea');
    area.className = 'subtitle-text';
    area.rows = 2;
    area.value = active.text;
    area.placeholder = '字幕の文字';
    area.disabled = !this.enabled;
    // 入力のたびに一覧を作り直すとカーソルが飛ぶので、文字だけ差し替える。
    area.addEventListener('input', () => {
      this.subtitles = updateSubtitle(this.subtitles, active.id, { text: area.value }, this.duration);
      this.#renderOverlay();
      this.#updateRowText(active.id, area.value);
      this.#emitChange();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-small';
    remove.textContent = 'この字幕を消す';
    remove.disabled = !this.enabled;
    remove.addEventListener('click', () => {
      this.subtitles = removeSubtitle(this.subtitles, active.id);
      this.#emitChange();
      this.#renderCurrent(true);
      this.#renderList();
      this.#renderOverlay();
    });

    box.append(times, area, remove);
  }

  #addHere() {
    const start = Math.max(0, Math.min(this.sourceTime, this.duration - MIN_SUBTITLE_DURATION));
    const end = Math.min(this.duration, start + NEW_SUBTITLE_SEC);
    this.subtitles = addSubtitle(this.subtitles, createSubtitle(start, end, ''));
    this.#emitChange();
    this.#renderCurrent(true);
    this.#renderList();
    this.#renderOverlay();
    this.dom.current.querySelector('textarea')?.focus();
  }

  #nudge(id, edge, delta) {
    const target = this.subtitles.find((s) => s.id === id);
    if (!target) return;
    this.subtitles = updateSubtitle(this.subtitles, id, { [edge]: target[edge] + delta }, this.duration);
    this.#emitChange();

    /*
     * 端を動かした結果、再生位置がその字幕の外に出ることがある
     * （1.05秒にいるときに始まりを1.15秒へ動かした、など）。
     * そのままだと編集していた欄が消えてしまうので、再生位置を中へ連れ戻す。
     */
    const moved = this.subtitles.find((s) => s.id === id);
    if (moved && (this.sourceTime < moved.start || this.sourceTime >= moved.end)) {
      const inside = Math.min(moved.end - 0.01, Math.max(moved.start + 0.01, this.sourceTime));
      this.sourceTime = inside;
      this.dispatchEvent(new CustomEvent('seek', { detail: { time: inside } }));
    }

    this.#renderCurrent(true);
    this.#renderList();
    this.#renderOverlay();
  }

  /* ---- 一覧 ---- */

  #renderList() {
    const list = this.dom.list;
    list.replaceChildren();

    if (this.subtitles.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'まだ字幕がありません。「字幕を作る」か「いまの位置に追加」から始めます。';
      list.append(empty);
      return;
    }

    for (const sub of this.subtitles) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'subtitle-row';
      row.dataset.id = sub.id;

      const time = document.createElement('span');
      time.className = 'subtitle-row-time';
      time.textContent = formatTime(sub.start);

      const text = document.createElement('span');
      text.className = 'subtitle-row-text';
      text.textContent = sub.text || '（空）';

      row.append(time, text);
      // 選ぶとその位置へ飛ぶ＝編集対象がその字幕に切り替わる
      row.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('seek', { detail: { time: sub.start + 0.01 } }));
      });
      list.append(row);
    }
    this.#markActiveRow();
  }

  #markActiveRow() {
    for (const row of this.dom.list.children) {
      if (!row.dataset) continue;
      row.classList?.toggle('is-active', row.dataset.id === this.editingId);
    }
  }

  /** 入力中に一覧を作り直さずに済ませるための、1行だけの更新。 */
  #updateRowText(id, value) {
    for (const row of this.dom.list.children) {
      if (row.dataset?.id !== id) continue;
      const text = row.querySelector('.subtitle-row-text');
      if (text) text.textContent = value || '（空）';
      return;
    }
  }

  #emitChange() {
    this.dispatchEvent(new CustomEvent('change', { detail: { subtitles: this.subtitles } }));
  }
}

/* ---- 部品 ---------------------------------------------------------------- */

/** 選択式のチップを並べる。activeId のものに印を付ける。 */
function chips(container, items, activeId, onPick, decorate) {
  container.replaceChildren();
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    const active = item.id === activeId;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
    btn.dataset.id = item.id;

    if (decorate) btn.append(decorate(item));
    const label = document.createElement('span');
    label.textContent = item.label;
    btn.append(label);

    btn.addEventListener('click', () => onPick(item.id));
    container.append(btn);
  }
}

/** 配色チップの色見本。文字色と縁取り（または帯）をそのまま見せる。 */
function swatch(scheme) {
  const box = document.createElement('span');
  box.className = 'chip-swatch';
  box.style.background = scheme.background ?? '#222';
  box.style.color = scheme.fill;
  box.style.borderColor = scheme.stroke ?? 'transparent';
  box.textContent = 'あ';
  return box;
}

/** 「始まり 0:01.2 ◀ ▶」の1組。 */
function nudgeGroup(label, value, onNudge, disabled) {
  const group = document.createElement('div');
  group.className = 'nudge-group';

  const name = document.createElement('span');
  name.className = 'nudge-label';
  name.textContent = label;

  const time = document.createElement('span');
  time.className = 'nudge-value';
  time.textContent = formatTime(value);

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-small';
  back.textContent = '◀';
  back.setAttribute('aria-label', `${label}を0.1秒早める`);
  back.disabled = disabled;
  back.addEventListener('click', () => onNudge(-NUDGE_SEC));

  const forward = document.createElement('button');
  forward.type = 'button';
  forward.className = 'btn btn-small';
  forward.textContent = '▶';
  forward.setAttribute('aria-label', `${label}を0.1秒遅らせる`);
  forward.disabled = disabled;
  forward.addEventListener('click', () => onNudge(NUDGE_SEC));

  group.append(name, time, back, forward);
  return group;
}
