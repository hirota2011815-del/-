/**
 * ステップ1: 書き出しの検証。
 *
 * mp4を開いて、カット・除外・速度変更だけを指定し、WebCodecsで書き出す。
 * 目的は「この端末で本当に書き出せるか」を確かめること。
 */
import { detectCapabilities, describeCapabilities, verdictMessage } from './core/capabilities.js';
import {
  SPEEDS,
  createEditList,
  load,
  outputDuration,
  save,
  setSpeed,
  splitAt,
  storageKey,
  toggleEnabled,
} from './core/edit-list.js';
import { formatBytes, formatTime } from './core/format.js';
import { canShareFile, downloadFile, outputFileName, shareFile } from './core/save-file.js';
import { acquireWakeLock, releaseWakeLock } from './core/wake-lock.js';
import { Exporter } from './export/controller.js';
import { DEFAULT_QUALITY, QUALITY_PRESETS, qualityLabel } from './export/quality.js';
import { ClipPlayer } from './ui/player.js';
import { Timeline } from './ui/timeline.js';

const el = (id) => document.getElementById(id);

const dom = {
  video: el('video'),
  previewPlaceholder: el('previewPlaceholder'),
  openBtn: el('openBtn'),
  fileInput: el('fileInput'),
  playBtn: el('playBtn'),
  cutBtn: el('cutBtn'),
  timeDisplay: el('timeDisplay'),
  sourceInfo: el('sourceInfo'),
  timeline: el('timeline'),
  clipList: el('clipList'),
  speedBar: el('speedBar'),
  speedButtons: el('speedButtons'),
  qualityButtons: el('qualityButtons'),
  exportEstimate: el('exportEstimate'),
  exportBtn: el('exportBtn'),
  progressBox: el('progressBox'),
  progressBar: el('progressBar'),
  progressText: el('progressText'),
  cancelBtn: el('cancelBtn'),
  resultBox: el('resultBox'),
  resultText: el('resultText'),
  resultCodecs: el('resultCodecs'),
  shareBtn: el('shareBtn'),
  downloadBtn: el('downloadBtn'),
  resultPreview: el('resultPreview'),
  exportError: el('exportError'),
  verdict: el('verdict'),
  capList: el('capList'),
  copyCapsBtn: el('copyCapsBtn'),
};

const state = {
  file: null,
  objectUrl: null,
  editList: null,
  storageKey: null,
  selectedClipId: null,
  quality: DEFAULT_QUALITY,
  capabilities: null,
  exporting: false,
  resultFile: null,
  resultUrl: null,
};

const player = new ClipPlayer(dom.video);
const timeline = new Timeline(dom.timeline);
const exporter = new Exporter();

/* ---- 起動 --------------------------------------------------------------- */

async function boot() {
  renderQualityButtons();
  renderSpeedButtons();
  renderClips();
  wireEvents();

  state.capabilities = await detectCapabilities();
  renderCapabilities(state.capabilities);
  updateExportAvailability();
  requestAnimationFrame(() => timeline.resize());
}

function wireEvents() {
  dom.openBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) openFile(file);
    e.target.value = '';
  });

  dom.playBtn.addEventListener('click', () => player.togglePlay());
  dom.cutBtn.addEventListener('click', cutAtPlayhead);
  dom.exportBtn.addEventListener('click', startExport);
  dom.cancelBtn.addEventListener('click', () => exporter.cancel());
  dom.downloadBtn.addEventListener('click', () => state.resultFile && downloadFile(state.resultFile));
  dom.shareBtn.addEventListener('click', onShare);
  dom.copyCapsBtn.addEventListener('click', copyCapabilities);

  timeline.addEventListener('seek', (e) => {
    player.seekSource(e.detail.time);
    selectClipAt(e.detail.time);
  });

  player.addEventListener('timeupdate', onPlayerTimeUpdate);
  player.addEventListener('statechange', () => {
    dom.playBtn.textContent = player.playing ? '一時停止' : '再生';
  });

  // スペースキーでカット（仕様どおり「ここでカット」に割り当て）
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target instanceof HTMLInputElement) return;
    if (!state.editList) return;
    e.preventDefault();
    cutAtPlayhead();
  });

  dom.video.addEventListener('loadedmetadata', () => timeline.resize());
}

/* ---- ファイルを開く ------------------------------------------------------ */

async function openFile(file) {
  resetResult();
  dom.exportError.hidden = true;

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = file;
  state.objectUrl = URL.createObjectURL(file);
  dom.video.src = state.objectUrl;
  dom.previewPlaceholder.hidden = true;

  const duration = await waitForDuration(dom.video);
  if (!duration) {
    showError('この動画の長さを読み取れませんでした。別のファイルで試してください。');
    return;
  }

  state.storageKey = storageKey(file);
  state.editList = load(state.storageKey, duration) ?? createEditList(file.name, duration);
  state.selectedClipId = state.editList.clips[0].id;

  player.setEditList(state.editList);
  timeline.setEditList(state.editList);
  timeline.setSelected(state.selectedClipId);
  timeline.resize();

  dom.sourceInfo.textContent = `${file.name} · ${formatTime(duration)} · ${formatBytes(file.size)}`;
  dom.playBtn.disabled = false;
  dom.cutBtn.disabled = false;
  player.seekSource(state.editList.clips[0].in);

  renderClips();
  updateExportAvailability();
  onPlayerTimeUpdate();
}

function waitForDuration(video) {
  return new Promise((resolve) => {
    const done = () => {
      const d = video.duration;
      resolve(Number.isFinite(d) && d > 0 ? d : null);
    };
    if (Number.isFinite(video.duration) && video.duration > 0) {
      done();
      return;
    }
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('error', () => resolve(null), { once: true });
  });
}

/* ---- 編集操作 ------------------------------------------------------------ */

function commit(nextList, { selectId } = {}) {
  state.editList = nextList;
  if (selectId) state.selectedClipId = selectId;
  player.setEditList(nextList);
  timeline.setEditList(nextList);
  timeline.setSelected(state.selectedClipId);
  renderClips();
  updateExportAvailability();
  if (state.storageKey) save(nextList, state.storageKey);
}

function cutAtPlayhead() {
  if (!state.editList) return;
  const { list, newClipId } = splitAt(state.editList, player.currentTime);
  if (!newClipId) return;
  commit(list, { selectId: newClipId });
}

function selectClipAt(t) {
  if (!state.editList) return;
  const clip = state.editList.clips.find((c) => t >= c.in && t < c.out);
  if (!clip) return;
  state.selectedClipId = clip.id;
  timeline.setSelected(clip.id);
  renderClips();
}

/* ---- 描画 ---------------------------------------------------------------- */

function onPlayerTimeUpdate() {
  const t = player.currentTime;
  timeline.setPlayhead(t);
  const total = state.editList ? state.editList.duration : 0;
  dom.timeDisplay.textContent = `${formatTime(t)} / ${formatTime(total)}`;
}

function renderClips() {
  dom.clipList.replaceChildren();
  if (!state.editList) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '動画を開くとここにクリップが並びます。';
    dom.clipList.append(p);
    dom.speedBar.hidden = true;
    return;
  }

  state.editList.clips.forEach((clip, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'clip-card';
    if (clip.id === state.selectedClipId) card.classList.add('is-selected');
    if (!clip.enabled) card.classList.add('is-disabled');

    const name = document.createElement('div');
    name.className = 'clip-name';
    name.textContent = `クリップ ${i + 1}`;

    const range = document.createElement('div');
    range.className = 'clip-range';
    range.textContent = `${formatTime(clip.in)} – ${formatTime(clip.out)}`;

    const meta = document.createElement('div');
    meta.className = 'clip-meta';
    if (clip.enabled) {
      meta.textContent = `×${clip.speed} · ${formatTime((clip.out - clip.in) / clip.speed)}`;
    } else {
      meta.className = 'clip-meta clip-excluded';
      meta.textContent = '除外中 · タップで戻す';
    }

    card.append(name, range, meta);
    card.addEventListener('click', () => onClipTap(clip));
    dom.clipList.append(card);
  });

  const selected = state.editList.clips.find((c) => c.id === state.selectedClipId);
  dom.speedBar.hidden = !selected;
  if (selected) updateSpeedButtons(selected.speed);
}

/**
 * クリップをタップしたとき。
 * 選択されていないクリップなら選択、すでに選択中のものなら除外／復活をトグルする。
 * （仕様の「クリップをタップしてトグル」を、選択操作と両立させるための扱い）
 */
function onClipTap(clip) {
  if (clip.id !== state.selectedClipId) {
    state.selectedClipId = clip.id;
    timeline.setSelected(clip.id);
    if (clip.enabled) player.seekSource(clip.in);
    renderClips();
    return;
  }
  commit(toggleEnabled(state.editList, clip.id));
}

function renderSpeedButtons() {
  dom.speedButtons.replaceChildren();
  for (const speed of SPEEDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';
    btn.dataset.speed = String(speed);
    btn.textContent = `×${speed}`;
    btn.addEventListener('click', () => {
      if (!state.selectedClipId) return;
      commit(setSpeed(state.editList, state.selectedClipId, speed));
    });
    dom.speedButtons.append(btn);
  }
}

function updateSpeedButtons(active) {
  for (const btn of dom.speedButtons.children) {
    btn.classList.toggle('is-active', Number(btn.dataset.speed) === active);
  }
}

function renderQualityButtons() {
  dom.qualityButtons.replaceChildren();
  for (const preset of QUALITY_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.setAttribute('role', 'radio');
    btn.classList.toggle('is-active', preset.id === state.quality);
    btn.setAttribute('aria-checked', String(preset.id === state.quality));

    const label = document.createElement('span');
    label.textContent = preset.label;
    const hint = document.createElement('span');
    hint.className = 'q-hint';
    hint.textContent = preset.hint;
    btn.append(label, hint);

    btn.addEventListener('click', () => {
      state.quality = preset.id;
      renderQualityButtons();
      updateExportAvailability();
    });
    dom.qualityButtons.append(btn);
  }
}

function renderCapabilities(caps) {
  const verdict = verdictMessage(caps);
  dom.verdict.textContent = verdict.text;
  dom.verdict.className = `verdict tone-${verdict.tone}`;

  dom.capList.replaceChildren();
  for (const row of describeCapabilities(caps)) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = row.label;
    const value = document.createElement('span');
    value.className = row.ok ? 'cap-ok' : 'cap-ng';
    value.textContent = row.ok ? '対応' : '非対応';
    li.append(label, value);
    dom.capList.append(li);
  }
}

async function copyCapabilities() {
  const caps = state.capabilities ?? {};
  const lines = [
    `userAgent: ${navigator.userAgent}`,
    ...describeCapabilities(caps).map((r) => `${r.label}: ${r.ok ? 'OK' : 'NG'}`),
    `判定: ${caps.verdict ?? '-'}`,
  ];
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    dom.copyCapsBtn.textContent = 'コピーしました';
  } catch {
    dom.copyCapsBtn.textContent = 'コピーできませんでした';
  }
  setTimeout(() => {
    dom.copyCapsBtn.textContent = '結果をコピー';
  }, 2000);
}

/* ---- 書き出し ------------------------------------------------------------ */

function updateExportAvailability() {
  const caps = state.capabilities;
  const ready = Boolean(state.file && state.editList) && caps?.canExport === true && !state.exporting;
  dom.exportBtn.disabled = !ready;

  if (!state.editList) {
    dom.exportEstimate.textContent = '';
    return;
  }
  const out = outputDuration(state.editList);
  dom.exportEstimate.textContent =
    out > 0
      ? `書き出しの長さ: ${formatTime(out)}（${qualityLabel(state.quality)}）`
      : 'すべてのクリップが除外されています。';
}

async function startExport() {
  if (state.exporting || !state.file || !state.editList) return;
  if (outputDuration(state.editList) <= 0) {
    showError('すべてのクリップが除外されています。どれかを復活させてください。');
    return;
  }

  state.exporting = true;
  resetResult();
  dom.exportError.hidden = true;
  dom.progressBox.hidden = false;
  dom.exportBtn.disabled = true;
  setProgress(0, '準備中…');

  player.video.pause();
  const startedAt = performance.now();
  await acquireWakeLock();

  try {
    const result = await exporter.run({
      file: state.file,
      editList: JSON.parse(JSON.stringify(state.editList)),
      quality: state.quality,
      onProgress: (p) => setProgress(p.ratio, progressLabel(p)),
    });
    showResult(result, performance.now() - startedAt);
  } catch (err) {
    if (err?.name === 'ExportCanceled') {
      dom.progressText.textContent = '中止しました。';
    } else {
      showError(err?.message ?? String(err));
      console.error(err);
    }
  } finally {
    await releaseWakeLock();
    state.exporting = false;
    dom.progressBox.hidden = true;
    updateExportAvailability();
  }
}

function progressLabel(p) {
  const percent = Math.round(p.ratio * 100);
  switch (p.phase) {
    case 'prepare':
      return p.detail ?? '準備中…';
    case 'finalize':
      return 'mp4にまとめています…';
    default:
      return `書き出し中 ${percent}%${p.detail ? ` · ${p.detail}` : ''}`;
  }
}

function setProgress(ratio, text) {
  dom.progressBar.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  dom.progressText.textContent = text;
}

function showResult(result, elapsedMs) {
  const file = new File([result.buffer], outputFileName(state.file.name), {
    type: result.mimeType || 'video/mp4',
  });
  state.resultFile = file;
  state.resultUrl = URL.createObjectURL(file);

  const parts = [
    `${formatTime(result.durationSec)}`,
    `${result.width}×${result.height}`,
    formatBytes(file.size),
    `処理 ${(elapsedMs / 1000).toFixed(1)}秒`,
  ];
  if (!result.hasAudio) parts.push('音声なし');
  dom.resultText.textContent = `書き出しました — ${parts.join(' · ')}`;

  // 実機で何が動いたかを報告できるよう、使われたコーデック文字列も出す。
  const codecs = [result.videoEncoderConfig?.codec, result.audioEncoderConfig?.codec].filter(Boolean);
  dom.resultCodecs.textContent = codecs.length ? `使用コーデック: ${codecs.join(' / ')}` : '';

  dom.shareBtn.hidden = !canShareFile(file);
  dom.resultPreview.src = state.resultUrl;
  dom.resultBox.hidden = false;
}

async function onShare() {
  if (!state.resultFile) return;
  const outcome = await shareFile(state.resultFile);
  if (outcome === 'unavailable') downloadFile(state.resultFile);
}

function resetResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  state.resultFile = null;
  dom.resultPreview.removeAttribute('src');
  dom.resultBox.hidden = true;
}

function showError(message) {
  dom.exportError.textContent = message;
  dom.exportError.hidden = false;
}

boot();
