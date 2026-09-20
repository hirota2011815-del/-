/**
 * 素のロジックだけの検証（ブラウザ不要）。
 *
 *   node test/run-unit-tests.js
 */
import assert from 'node:assert/strict';
import {
  MIN_CLIP_DURATION,
  createEditList,
  enabledClips,
  outputDuration,
  outputTimeToSource,
  setSpeed,
  sourceTimeToOutput,
  splitAt,
  toJSON,
  toggleEnabled,
  trimClip,
} from '../src/core/edit-list.js';
import { LinearResampler } from '../src/export/resampler.js';
import { videoBitrate } from '../src/export/quality.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message.split('\n')[0]}`);
  }
}

console.log('\n編集リスト');

test('最初は全体が1クリップ', () => {
  const list = createEditList('a.mp4', 30);
  assert.equal(list.clips.length, 1);
  assert.equal(list.clips[0].in, 0);
  assert.equal(list.clips[0].out, 30);
  assert.equal(list.clips[0].speed, 1);
  assert.equal(list.clips[0].enabled, true);
});

test('カットで2つに割れる', () => {
  const { list, newClipId } = splitAt(createEditList('a.mp4', 30), 12);
  assert.equal(list.clips.length, 2);
  assert.deepEqual([list.clips[0].in, list.clips[0].out], [0, 12]);
  assert.deepEqual([list.clips[1].in, list.clips[1].out], [12, 30]);
  assert.equal(list.clips[1].id, newClipId);
});

test('端すぎる位置ではカットしない', () => {
  const base = createEditList('a.mp4', 30);
  assert.equal(splitAt(base, MIN_CLIP_DURATION / 2).newClipId, null);
  assert.equal(splitAt(base, 30).newClipId, null);
  assert.equal(splitAt(base, 0).newClipId, null);
});

test('カットしても元の in/out は変わらない（非破壊）', () => {
  const base = createEditList('a.mp4', 30);
  splitAt(base, 12);
  assert.equal(base.clips.length, 1, '元のリストが書き換えられている');
});

test('除外しても消えない。もう一度押すと戻る', () => {
  let list = splitAt(createEditList('a.mp4', 30), 12).list;
  const id = list.clips[0].id;
  list = toggleEnabled(list, id);
  assert.equal(list.clips.length, 2);
  assert.equal(enabledClips(list).length, 1);
  list = toggleEnabled(list, id);
  assert.equal(enabledClips(list).length, 2);
});

test('速度は固定値だけ受け付ける', () => {
  const list = createEditList('a.mp4', 30);
  const id = list.clips[0].id;
  assert.equal(setSpeed(list, id, 1.5).clips[0].speed, 1.5);
  assert.equal(setSpeed(list, id, 3).clips[0].speed, 1, '×3 が通ってしまう');
  assert.equal(setSpeed(list, id, 0.1).clips[0].speed, 1);
});

test('書き出しの長さは速度と除外を反映する', () => {
  let list = createEditList('a.mp4', 30);
  list = splitAt(list, 10).list;            // 0-10, 10-30
  list = splitAt(list, 20).list;            // 0-10, 10-20, 20-30
  list = setSpeed(list, list.clips[1].id, 2);       // 10秒 → 5秒
  list = toggleEnabled(list, list.clips[2].id);     // 10秒 → 0秒
  assert.equal(outputDuration(list), 15);
});

test('トリムは隣のクリップを越えない', () => {
  let list = splitAt(createEditList('a.mp4', 30), 12).list;
  const second = list.clips[1].id;
  list = trimClip(list, second, 'in', 5);   // 手前のクリップは 0-12 なので 12 で止まる
  assert.equal(list.clips[1].in, 12);
  list = trimClip(list, second, 'out', 100); // 全長 30 で止まる
  assert.equal(list.clips[1].out, 30);
  list = trimClip(list, second, 'in', 20);
  assert.equal(list.clips[1].in, 20);
});

test('元動画の時刻と書き出し後の時刻を相互に変換できる', () => {
  let list = createEditList('a.mp4', 30);
  list = splitAt(list, 10).list;
  list = splitAt(list, 20).list;
  list = toggleEnabled(list, list.clips[1].id);   // 10-20 を除外
  list = setSpeed(list, list.clips[2].id, 2);     // 20-30 を ×2

  assert.equal(sourceTimeToOutput(list, 5), 5);
  assert.equal(sourceTimeToOutput(list, 15), 10, '除外区間は手前に詰まる');
  assert.equal(sourceTimeToOutput(list, 25), 12.5);
  assert.equal(outputTimeToSource(list, 5), 5);
  assert.equal(outputTimeToSource(list, 10), 20, '除外の次のクリップの頭へ');
  assert.equal(outputTimeToSource(list, 12.5), 25);
});

test('保存形式が仕様どおりの形になる', () => {
  const list = createEditList('IMG_0431.mp4', 30);
  const json = toJSON(list);
  assert.equal(json.source, 'IMG_0431.mp4');
  assert.deepEqual(Object.keys(json.clips[0]).sort(), ['enabled', 'filter', 'id', 'in', 'out', 'speed']);
  assert.equal(json.clips[0].filter, null);
  assert.deepEqual(Object.keys(json.audio).sort(), ['highpassHz', 'limiterDb', 'normalizeGainDb']);
  assert.deepEqual(json.markers, []);
});

console.log('\n音声リサンプラ');

function resampleAll(input, speed, chunk) {
  const r = new LinearResampler(1, speed);
  const out = [];
  for (let i = 0; i < input.length; i += chunk) {
    const [plane] = r.push([input.slice(i, i + chunk)]);
    out.push(...plane);
  }
  out.push(...r.flush()[0]);
  return Float32Array.from(out);
}

test('等速なら値がそのまま通る', () => {
  const input = Float32Array.from({ length: 100 }, (_, i) => i / 100);
  const out = resampleAll(input, 1, 16);
  assert.equal(out.length, 100);
  for (let i = 0; i < 100; i += 1) {
    assert.ok(Math.abs(out[i] - input[i]) < 1e-6, `${i}: ${out[i]} != ${input[i]}`);
  }
});

test('×2 で長さが半分になる', () => {
  const input = new Float32Array(1000);
  const out = resampleAll(input, 2, 64);
  assert.ok(Math.abs(out.length - 500) <= 1, `${out.length}`);
});

test('×0.5 で長さが倍になる', () => {
  const input = new Float32Array(1000);
  const out = resampleAll(input, 0.5, 64);
  assert.ok(Math.abs(out.length - 2000) <= 2, `${out.length}`);
});

test('チャンクの切れ目で波形が途切れない', () => {
  // 直線を ×0.5 で伸ばすと、やはり直線のまま（傾きは半分）になるはず。
  const input = Float32Array.from({ length: 512 }, (_, i) => i);
  const out = resampleAll(input, 0.5, 33); // 割り切れないチャンク幅でまたがせる
  for (let i = 1; i < out.length - 2; i += 1) {
    const delta = out[i] - out[i - 1];
    assert.ok(Math.abs(delta - 0.5) < 1e-3, `${i} 番目の段差が ${delta}`);
  }
});

test('ステレオの左右が混ざらない', () => {
  const r = new LinearResampler(2, 1);
  const left = Float32Array.from({ length: 64 }, () => 1);
  const right = Float32Array.from({ length: 64 }, () => -1);
  const [l, rr] = r.push([left, right]);
  assert.ok(l.every((v) => Math.abs(v - 1) < 1e-6));
  assert.ok(rr.every((v) => Math.abs(v + 1) < 1e-6));
});

console.log('\n書き出し画質');

test('画質が上がるほどビットレートが上がる', () => {
  const high = videoBitrate('high', 1920, 1080);
  const std = videoBitrate('standard', 1920, 1080);
  const light = videoBitrate('light', 1920, 1080);
  assert.equal(std, 6_000_000);
  assert.ok(high > std && std > light);
});

test('解像度が下がるとビットレートも下がる', () => {
  assert.ok(videoBitrate('standard', 1280, 720) < videoBitrate('standard', 1920, 1080));
  assert.ok(videoBitrate('standard', 3840, 2160) > videoBitrate('standard', 1920, 1080));
});

console.log(`\n${passed} 件通過 / ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
