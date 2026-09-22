/**
 * ヘッドレスChromiumで書き出しの検証を走らせる。
 *
 *   node test/run-browser-tests.js
 *
 * ここで確かめるのはパイプラインの正しさ（カット・除外・速度・長さ・音ずれ）。
 * H.264/AAC そのものが通るかは実機でしか分からないので、それは端末側で確認する。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { serve } from './serve.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const { server, port } = await serve(ROOT);
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

let failed = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [browser]', m.text());
  });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message));

  /* --- 1. 書き出しパイプライン --- */
  await page.goto(`http://localhost:${port}/test/harness.html`);
  await page.waitForFunction(() => typeof window.__runSuite === 'function');
  const results = await page.evaluate(() => window.__runSuite());

  console.log('\n書き出しパイプライン');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 1.5. タイムラインの操作（タップ・ドラッグ・ピンチ・トリム） --- */
  await page.waitForFunction(() => typeof window.__runInteractionSuite === 'function');
  const interactionResults = await page.evaluate(() => window.__runInteractionSuite());

  console.log('\nタイムライン操作');
  for (const r of interactionResults) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 1.6. 波形解析（音声のピーク/RMS抽出） --- */
  await page.waitForFunction(() => typeof window.__runWaveformSuite === 'function');
  const waveformResults = await page.evaluate(() => window.__runWaveformSuite());

  console.log('\n波形解析');
  for (const r of waveformResults) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 1.7. 音の仕上げが書き出しに効いているか --- */
  await page.waitForFunction(() => typeof window.__runAudioEffectsSuite === 'function');
  const effectResults = await page.evaluate(() => window.__runAudioEffectsSuite());

  console.log('\n音の仕上げ');
  for (const r of effectResults) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 1.8. 字幕の焼き込み --- */
  await page.waitForFunction(() => typeof window.__runSubtitleSuite === 'function');
  const subtitleResults = await page.evaluate(() => window.__runSubtitleSuite());

  console.log('\n字幕の焼き込み');
  for (const r of subtitleResults) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 1.9. 字幕パネルの操作 --- */
  await page.waitForFunction(() => typeof window.__runSubtitlePanelSuite === 'function');
  const panelResults = await page.evaluate(() => window.__runSubtitlePanelSuite());

  console.log('\n字幕パネルの操作');
  for (const r of panelResults) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 1.10. 文字起こしライブラリが読み込めるか --- */
  await page.waitForFunction(() => typeof window.__runTranscribeLibrarySuite === 'function');
  const libResults = await page.evaluate(() => window.__runTranscribeLibrarySuite());

  console.log('\n文字起こしの部品');
  for (const r of libResults) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    if (!r.pass) failed += 1;
  }

  /* --- 2. 画面が組み上がるか --- */
  console.log('\n画面');
  const errors = [];
  const uiPage = await browser.newPage();
  uiPage.on('pageerror', (e) => errors.push(e.message));
  uiPage.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await uiPage.goto(`http://localhost:${port}/index.html`);
  await uiPage.waitForFunction(() => document.querySelectorAll('#capList li').length > 0, null, {
    timeout: 10_000,
  });

  const ui = await uiPage.evaluate(() => ({
    caps: document.querySelectorAll('#capList li').length,
    verdict: document.getElementById('verdict').textContent,
    quality: document.querySelectorAll('#qualityButtons .btn').length,
    speeds: [...document.querySelectorAll('#speedButtons .btn')].map((b) => b.textContent),
    exportDisabled: document.getElementById('exportBtn').disabled,
    timelineHeight: document.getElementById('timeline').height,
    hasLevelMeter: document.getElementById('levelMeter') !== null,
    meterWidth: document.getElementById('levelMeter').getBoundingClientRect().width,
    toggles: [...document.querySelectorAll('#effectToggles .toggle-row')].map((b) => ({
      label: b.querySelector('.toggle-label').textContent,
      on: b.getAttribute('aria-checked') === 'true',
    })),
    thresholds: [...document.querySelectorAll('#silenceThresholds .btn')].map((b) => b.textContent),
    silenceDisabled: document.getElementById('silenceCutBtn').disabled,
    subtitleSchemes: document.querySelectorAll('#subtitleSchemes .chip').length,
    subtitleFonts: document.querySelectorAll('#subtitleFonts .chip').length,
    subtitlePositions: document.querySelectorAll('#subtitlePositions .chip').length,
    subtitleSizes: document.querySelectorAll('#subtitleSizes .chip').length,
    transcribeModels: [...document.querySelectorAll('#transcribeModels .btn')].map((b) => b.textContent),
    transcribeDisabled: document.getElementById('transcribeBtn').disabled,
    subtitleOverlayHidden: document.getElementById('subtitleOverlay').hidden,
    subtitleListText: document.getElementById('subtitleList').textContent,
  }));

  const uiChecks = [
    ['対応状況が9項目出る', ui.caps === 9, `${ui.caps}`],
    ['画質ボタンが3つ', ui.quality === 3],
    ['速度ボタンが6つ固定値', JSON.stringify(ui.speeds) === JSON.stringify(['×0.5', '×0.75', '×1', '×1.25', '×1.5', '×2']), ui.speeds.join(',')],
    ['動画未読み込みでは書き出せない', ui.exportDisabled === true],
    ['タイムラインのcanvasが実寸に合わせられる', ui.timelineHeight > 0, `${ui.timelineHeight}`],
    ['dBグリッド分の高さが確保されている', ui.timelineHeight >= 100, `${ui.timelineHeight}`],
    ['レベルメーターの要素がある', ui.hasLevelMeter],
    ['レベルメーターがプレビューの横に並んでいる', ui.meterWidth > 0, `${ui.meterWidth}`],
    ['音の仕上げのトグルが5つ', ui.toggles.length === 5, ui.toggles.map((t) => t.label).join(',')],
    [
      '初期ONは4つ（ノイズを減らすだけOFF）',
      ui.toggles.filter((t) => t.on).length === 4 && ui.toggles.find((t) => t.label.startsWith('ノイズ'))?.on === false,
      ui.toggles.map((t) => `${t.label}:${t.on ? 'ON' : 'OFF'}`).join(' '),
    ],
    ['無音のしきい値が3択', ui.thresholds.length === 3, ui.thresholds.join(',')],
    ['波形の解析前は無音カットを押せない', ui.silenceDisabled === true],
    ['字幕の配色が6つ・書体が4つ', ui.subtitleSchemes === 6 && ui.subtitleFonts === 4, `${ui.subtitleSchemes}/${ui.subtitleFonts}`],
    ['字幕の位置と大きさが3つずつ', ui.subtitlePositions === 3 && ui.subtitleSizes === 3],
    ['文字起こしのモデルが2択', ui.transcribeModels.length === 2, ui.transcribeModels.join(',')],
    ['動画未読み込みでは文字起こしできない', ui.transcribeDisabled === true],
    ['字幕が無いときはプレビューに重ならない', ui.subtitleOverlayHidden === true],
    ['字幕が無いときは一覧に案内が出る', ui.subtitleListText.includes('まだ字幕がありません'), ui.subtitleListText.trim().slice(0, 30)],
    ['JSエラーが出ない', errors.length === 0, errors.join(' | ')],
  ];
  for (const [name, pass, detail] of uiChecks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!pass) failed += 1;
  }

  // H.264が無いビルドなので、判定は「非対応」と出るのが正しい挙動
  console.log(`\n  （このChromiumはH.264非対応のため、判定は "${ui.verdict.trim()}" になります）`);
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\n全て通りました。' : `\n${failed} 件失敗しました。`);
process.exit(failed === 0 ? 0 : 1);
