/**
 * ステップ1: 書き出しの検証。
 *
 * mp4を開いて、カット・除外・速度変更だけを指定し、WebCodecsで書き出す。
 * 目的は「この端末で本当に書き出せるか」を確かめること。
 */
import { EFFECT_TOGGLES, computeNormalizeGainDb, defaultAudioSettings } from './audio/effects.js';
import { PreviewAudio } from './audio/preview-audio.js';
import {
  DEFAULT_SILENCE_THRESHOLD_DB,
  SILENCE_THRESHOLDS_DB,
  describeSilenceCut,
  detectSoundedRanges,
} from './audio/silence.js';
import { WaveformAnalyzer } from './audio/waveform-controller.js';
import { concatFloat32, getAudioChannelCount } from './audio/waveform.js';
import { detectCapabilities, describeCapabilities, verdictMessage } from './core/capabilities.js';
import {
  SPEEDS,
  createEditList,
  load,
  outputDuration,
  save,
  setSpeed,
  splitAt,
  replaceClips,
  storageKey,
  toggleEnabled,
  trimClip,
} from './core/edit-list.js';
import { formatBytes, formatTime } from './core/format.js';
import { canShareFile, downloadFile, outputFileName, shareFile } from './core/save-file.js';
import { acquireWakeLock, releaseWakeLock } from './core/wake-lock.js';
import { Exporter } from './export/controller.js';
import { DEFAULT_QUALITY, QUALITY_PRESETS, qualityLabel } from './export/quality.js';
import { MeterView } from './ui/meter.js';
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
  levelMeter: el('levelMeter'),
  waveformProgress: el('waveformProgress'),
  effectToggles: el('effectToggles'),
  silenceThresholds: el('silenceThresholds'),
  silenceCutBtn: el('silenceCutBtn'),
  silenceUndoBtn: el('silenceUndoBtn'),
  silenceResult: el('silenceResult'),
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
  waveform: null, // { peaks, rms, sampleRate, bucketFrames }
  silenceThresholdDb: DEFAULT_SILENCE_THRESHOLD_DB,
  waveformComplete: false, // 解析が最後まで終わったか（途中のデータで無音カットしないため）
  silenceUndo: null, // 無音カットの直前の編集リスト
};

const player = new ClipPlayer(dom.video);
const timeline = new Timeline(dom.timeline);
const exporter = new Exporter();
const waveformAnalyzer = new WaveformAnalyzer();
const previewAudio = new PreviewAudio(dom.video);
const meterView = new MeterView(dom.levelMeter);

// トリムのドラッグ中、DOM更新を1フレームに1回へ間引くための一時置き場。
let pendingTrim = null;
let trimRafId = 0;

// 再生中だけ、レベルメーターをrequestAnimationFrameで更新する。
let meterRafId = 0;

/* ---- 起動 --------------------------------------------------------------- */

async function boot() {
  renderQualityButtons();
  renderSpeedButtons();
  renderSilenceThresholds();
  renderClips();
  renderAudioSection();
  wireEvents();

  state.capabilities = await detectCapabilities();
  renderCapabilities(state.capabilities);
  updateExportAvailability();
  requestAnimationFrame(() => {
    timeline.resize();
    meterView.resize();
  });
}

function wireEvents() {
  dom.openBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) openFile(file);
    e.target.value = '';
  });

  dom.playBtn.addEventListener('click', () => {
    // AudioContextはユーザー操作のハンドラ内でないと始められないため、ここで起動する。
    previewAudio.start();
    player.togglePlay();
  });
  dom.cutBtn.addEventListener('click', cutAtPlayhead);
  dom.exportBtn.addEventListener('click', startExport);
  dom.cancelBtn.addEventListener('click', () => exporter.cancel());
  dom.downloadBtn.addEventListener('click', () => state.resultFile && downloadFile(state.resultFile));
  dom.shareBtn.addEventListener('click', onShare);
  dom.copyCapsBtn.addEventListener('click', copyCapabilities);
  dom.silenceCutBtn.addEventListener('click', applySilenceCut);
  dom.silenceUndoBtn.addEventListener('click', undoSilenceCut);

  timeline.addEventListener('seek', (e) => {
    player.seekSource(e.detail.time);
    selectClipAt(e.detail.time);
  });
  // ドラッグ中は指の動きの回数だけ飛んでくるので、DOM更新は1フレームに1回にまとめる。
  timeline.addEventListener('trim', (e) => {
    pendingTrim = e.detail;
    if (trimRafId) return;
    trimRafId = requestAnimationFrame(() => {
      trimRafId = 0;
      if (pendingTrim) commit(trimClip(state.editList, pendingTrim.clipId, pendingTrim.edge, pendingTrim.time));
      pendingTrim = null;
    });
  });

  player.addEventListener('timeupdate', onPlayerTimeUpdate);
  player.addEventListener('statechange', () => {
    dom.playBtn.textContent = player.playing ? '一時停止' : '再生';
    if (player.playing) {
      startMeterLoop();
    } else {
      stopMeterLoop();
    }
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

/* ---- レベルメーター -------------------------------------------------------- */

function startMeterLoop() {
  if (meterRafId) return;
  const loop = () => {
    meterView.setLevels(previewAudio.read());
    meterRafId = requestAnimationFrame(loop);
  };
  meterRafId = requestAnimationFrame(loop);
}

function stopMeterLoop() {
  if (meterRafId) cancelAnimationFrame(meterRafId);
  meterRafId = 0;
  meterView.setLevels(null); // 静止画面に戻す
}

/* ---- 波形解析 -------------------------------------------------------------- */

async function analyzeWaveformFor(file) {
  state.waveform = { peaks: new Float32Array(0), rms: new Float32Array(0), sampleRate: 0, bucketFrames: 0 };
  state.waveformComplete = false;
  renderAudioSection();
  dom.waveformProgress.hidden = false;
  dom.waveformProgress.textContent = '波形を解析中…';

  try {
    const channels = await getAudioChannelCount(file);
    meterView.setChannelCount(channels || 1);
    if (channels === 0) {
      dom.waveformProgress.textContent = 'この動画には音声トラックがありません。';
      return;
    }

    const result = await waveformAnalyzer.run({
      file,
      onChunk: (chunk) => {
        if (state.file !== file) return; // 別のファイルに切り替わっていたら捨てる
        state.waveform = {
          peaks: concatFloat32(state.waveform.peaks, chunk.peaksSlice),
          rms: concatFloat32(state.waveform.rms, chunk.rmsSlice),
          sampleRate: chunk.sampleRate,
          bucketFrames: chunk.bucketFrames,
        };
        timeline.setWaveform(state.waveform);
        dom.waveformProgress.textContent = `波形を解析中… ${Math.round(chunk.ratio * 100)}%`;
      },
    });

    if (state.file !== file) return;
    if (!result) {
      dom.waveformProgress.textContent = 'この動画には音声トラックがありません。';
      return;
    }
    dom.waveformProgress.hidden = true;
    // 解析が出そろったので「音量をそろえる」の補正量を計算し直し、無音カットを解禁する。
    state.waveformComplete = true;
    commit(state.editList);
  } catch (err) {
    if (state.file !== file) return;
    dom.waveformProgress.textContent = `波形の解析に失敗しました: ${err?.message ?? err}`;
    console.error(err);
  }
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

  setSilenceUndo(null);
  dom.silenceResult.textContent = '';
  renderClips();
  renderAudioSection();
  updateExportAvailability();
  onPlayerTimeUpdate();

  analyzeWaveformFor(file);
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

function commit(nextList, { selectId, keepUndo = false } = {}) {
  // クリップが変わると「音量をそろえる」の補正量も変わるので、都度計算し直す。
  const withGain = withNormalizeGain(nextList);
  state.editList = withGain;
  if (selectId) state.selectedClipId = selectId;
  if (!keepUndo) setSilenceUndo(null);

  player.setEditList(withGain);
  timeline.setEditList(withGain);
  timeline.setSelected(state.selectedClipId);
  timeline.setWaveform(state.waveform);
  renderClips();
  renderAudioSection();
  updateExportAvailability();
  if (state.storageKey) save(withGain, state.storageKey);
}

/** 波形が分かっていれば、「音量をそろえる」の補正量を計算して埋め込む。 */
function withNormalizeGain(list) {
  const normalizeGainDb = computeNormalizeGainDb(state.waveform, list.clips);
  if (normalizeGainDb === list.audio.normalizeGainDb) return list;
  return { ...list, audio: { ...list.audio, normalizeGainDb } };
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
  if (!clip || clip.id === state.selectedClipId) return; // スクラブ中に毎回作り直さない
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

/* ---- 音の仕上げ ------------------------------------------------------------ */

/** 5つのトグルと無音カットの表示をまとめて更新する。 */
function renderAudioSection() {
  const audio = state.editList?.audio ?? null;
  // 動画を開く前は、まだ触れないが「開いたらこうなる」初期値を見せる
  // （全部OFFに見せると、実際の初期状態と食い違って紛らわしい）。
  const shown = audio ?? defaultAudioSettings();

  dom.effectToggles.replaceChildren();
  for (const toggle of EFFECT_TOGGLES) {
    const on = toggle.get(shown);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'toggle-row';
    row.setAttribute('role', 'switch');
    row.setAttribute('aria-checked', String(Boolean(on)));
    row.disabled = !audio;

    const text = document.createElement('span');
    text.className = 'toggle-text';

    const label = document.createElement('span');
    label.className = 'toggle-label';
    label.textContent = toggle.label;
    // 「音量をそろえる」だけは、実際に何dB動かすのかを見せる。
    if (toggle.id === 'normalize' && audio && on && audio.normalizeGainDb !== 0) {
      const value = document.createElement('span');
      value.className = 'toggle-value';
      const sign = audio.normalizeGainDb > 0 ? '+' : '';
      value.textContent = `${sign}${audio.normalizeGainDb.toFixed(1)}dB`;
      label.append(value);
    }

    const hint = document.createElement('span');
    hint.className = 'toggle-hint';
    hint.textContent = toggle.hint;

    const knob = document.createElement('span');
    knob.className = 'toggle-switch';

    text.append(label, hint);
    row.append(text, knob);
    row.addEventListener('click', () => onEffectToggle(toggle));
    dom.effectToggles.append(row);
  }

  if (audio) previewAudio.setSettings(audio);

  dom.silenceCutBtn.disabled = !state.waveformComplete;
  dom.silenceUndoBtn.hidden = state.silenceUndo === null;
}

function onEffectToggle(toggle) {
  if (!state.editList) return;
  const audio = state.editList.audio;
  const next = toggle.set(audio, !toggle.get(audio));
  commit({ ...state.editList, audio: next });
}

function renderSilenceThresholds() {
  dom.silenceThresholds.replaceChildren();
  // 数字だけだと意味が分からないので、どういう音を無音とみなすかを添える。
  const hints = { '-50': '静かな部屋', '-45': 'ふつう', '-38': '雑音が多い' };
  for (const db of SILENCE_THRESHOLDS_DB) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.setAttribute('role', 'radio');
    const active = db === state.silenceThresholdDb;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));

    const value = document.createElement('span');
    value.textContent = `${db}dB`;
    const hint = document.createElement('span');
    hint.className = 't-hint';
    hint.textContent = hints[String(db)] ?? '';
    btn.append(value, hint);

    btn.addEventListener('click', () => {
      state.silenceThresholdDb = db;
      renderSilenceThresholds();
    });
    dom.silenceThresholds.append(btn);
  }
}

function applySilenceCut() {
  if (!state.editList || !state.waveformComplete) return;

  const ranges = detectSoundedRanges(state.waveform, {
    duration: state.editList.duration,
    thresholdDb: state.silenceThresholdDb,
  });
  dom.silenceResult.textContent = describeSilenceCut(ranges, state.editList.duration);
  if (ranges.length === 0) return;

  const before = state.editList;
  const next = replaceClips(state.editList, ranges);
  setSilenceUndo(before);
  commit(next, { selectId: next.clips[0].id, keepUndo: true });
  player.seekSource(next.clips[0].in);
}

function undoSilenceCut() {
  if (!state.silenceUndo) return;
  const restored = state.silenceUndo;
  setSilenceUndo(null);
  dom.silenceResult.textContent = '';
  commit(restored, { selectId: restored.clips[0].id });
}

function setSilenceUndo(list) {
  state.silenceUndo = list;
  dom.silenceUndoBtn.hidden = list === null;
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
  // エンコーダがフレームを落としていないか（latencyMode: 'realtime' の副作用）。
  const dropped = (result.framesSubmitted ?? 0) - (result.packetsEncoded ?? 0);
  if (dropped > 0) parts.push(`${dropped}フレーム欠落`);
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
