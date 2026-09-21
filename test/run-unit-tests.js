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
import { applyPinch, clampView, nearestHandle, timeToX, xToTime } from '../src/ui/timeline-math.js';
import {
  CLIP_THRESHOLD_DB,
  DB_FLOOR,
  HOT_THRESHOLD_DB,
  aggregateRange,
  amplitudeToDb,
  dbToAmplitude,
  dbToY,
  loudnessHint,
} from '../src/audio/dbscale.js';
import { concatFloat32 } from '../src/audio/waveform.js';

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

console.log('\nタイムラインの座標計算（ズーム・パン・トリムの当たり判定）');

test('時刻とx座標は表示窓の中で線形に対応する', () => {
  assert.equal(timeToX(0, 10, 300, 0), 0);
  assert.equal(timeToX(0, 10, 300, 10), 300);
  assert.equal(timeToX(0, 10, 300, 5), 150);
  assert.equal(xToTime(0, 10, 300, 150), 5);
});

test('表示窓がずれていてもx座標は窓基準になる', () => {
  assert.equal(timeToX(20, 10, 300, 25), 150);
  assert.equal(xToTime(20, 10, 300, 0), 20);
});

test('ズームは最小値と全体長でクランプされる', () => {
  assert.deepEqual(clampView(0, 0.01, 30, 1), { viewStart: 0, viewDuration: 1 });
  assert.deepEqual(clampView(0, 1000, 30, 1), { viewStart: 0, viewDuration: 30 });
});

test('パンは0と(全体長-表示長)の間でクランプされる', () => {
  assert.deepEqual(clampView(-5, 10, 30, 1), { viewStart: 0, viewDuration: 10 });
  assert.deepEqual(clampView(100, 10, 30, 1), { viewStart: 20, viewDuration: 10 });
});

test('ピンチで指を広げるとズームインする（表示時間が短くなる）', () => {
  const result = applyPinch({
    viewStart: 0, viewDuration: 10, width: 300, duration: 30, minViewDuration: 1,
    prevMidX: 150, newMidX: 150, scaleDelta: 2, // 指の間隔が2倍に広がった
  });
  assert.ok(result.viewDuration < 10, `${result.viewDuration}`);
  assert.ok(Math.abs(result.viewDuration - 5) < 1e-9);
});

test('ピンチの中間点の時刻がズーム後も同じx位置に留まる', () => {
  // 中間点(x=150)は元の表示窓では時刻5秒。ズーム後もx=150に時刻5秒が来るはず。
  const before = { viewStart: 0, viewDuration: 10, width: 300 };
  const timeAtMidBefore = xToTime(before.viewStart, before.viewDuration, before.width, 150);
  const after = applyPinch({
    ...before, duration: 30, minViewDuration: 1, prevMidX: 150, newMidX: 150, scaleDelta: 2,
  });
  const timeAtMidAfter = xToTime(after.viewStart, after.viewDuration, before.width, 150);
  assert.ok(Math.abs(timeAtMidBefore - timeAtMidAfter) < 1e-9, `${timeAtMidBefore} vs ${timeAtMidAfter}`);
});

test('指を狭めるとズームアウトする', () => {
  const result = applyPinch({
    viewStart: 5, viewDuration: 5, width: 300, duration: 30, minViewDuration: 1,
    prevMidX: 150, newMidX: 150, scaleDelta: 0.5, // 間隔が半分に
  });
  assert.ok(Math.abs(result.viewDuration - 10) < 1e-9, `${result.viewDuration}`);
});

test('しきい値内なら最も近いハンドルが当たる', () => {
  const handles = [{ edge: 'in', x: 50 }, { edge: 'out', x: 200 }];
  assert.equal(nearestHandle(55, handles, 18).edge, 'in');
  assert.equal(nearestHandle(190, handles, 18).edge, 'out');
});

test('しきい値の外では何にも当たらない', () => {
  const handles = [{ edge: 'in', x: 50 }, { edge: 'out', x: 200 }];
  assert.equal(nearestHandle(100, handles, 18), null);
});

console.log('\ndB表示（振幅↔dB、集約、しきい値）');

test('振幅1.0（フルスケール）は0dB', () => {
  assert.ok(Math.abs(amplitudeToDb(1)) < 1e-9);
});

test('振幅0.5は約-6dB', () => {
  assert.ok(Math.abs(amplitudeToDb(0.5) - -6.0206) < 0.01);
});

test('無音はDB_FLOORに丸められる', () => {
  assert.equal(amplitudeToDb(0), DB_FLOOR);
  assert.equal(amplitudeToDb(-0.001), DB_FLOOR); // 負値が来ても壊れない
});

test('dBFSと振幅は往復できる', () => {
  assert.ok(Math.abs(dbToAmplitude(amplitudeToDb(0.3)) - 0.3) < 1e-6);
});

test('しきい値の定数がそれぞれ仕様どおり', () => {
  assert.equal(HOT_THRESHOLD_DB, -3);
  assert.equal(CLIP_THRESHOLD_DB, -0.6);
});

test('0dBは上端(y=0)、DB_FLOORは下端(y=height)に写る', () => {
  assert.equal(dbToY(0, 100), 0);
  assert.equal(dbToY(DB_FLOOR, 100), 100);
  assert.equal(dbToY(-30, 100), 50); // -60〜0の中点
});

test('範囲外のdBはクランプされる', () => {
  assert.equal(dbToY(10, 100), 0);
  assert.equal(dbToY(-999, 100), 100);
});

test('バケットの集約: 範囲内の最大がpeakになる', () => {
  const peaks = Float32Array.from([0.1, 0.5, 0.2, 0.9, 0.3]);
  const rms = Float32Array.from([0.1, 0.1, 0.1, 0.1, 0.1]);
  // sampleRate=10, bucketFrames=10 → 1バケット=1秒
  const { peak } = aggregateRange(peaks, rms, 10, 10, 1, 4); // インデックス1〜3
  // Float32Arrayを経由すると0.9はそのままの値では戻らない（float32の丸め誤差）ので近似で比べる。
  assert.ok(Math.abs(peak - 0.9) < 1e-6, `${peak}`);
});

test('バケットの集約: 同じ大きさのRMSを4個集約すると同じ値になる', () => {
  const peaks = Float32Array.from([0.5, 0.5, 0.5, 0.5]);
  const rms = Float32Array.from([0.2, 0.2, 0.2, 0.2]);
  const { rms: combined } = aggregateRange(peaks, rms, 10, 10, 0, 4);
  assert.ok(Math.abs(combined - 0.2) < 1e-6, `${combined}`);
});

test('ズームしすぎて範囲がバケット1個未満でも、一番近い値を返す', () => {
  const peaks = Float32Array.from([0.1, 0.9, 0.2]);
  const rms = Float32Array.from([0.1, 0.4, 0.1]);
  const { peak } = aggregateRange(peaks, rms, 10, 10, 1.02, 1.03); // 2番目のバケットのごく一部
  assert.ok(Math.abs(peak - 0.9) < 1e-6, `${peak}`);
});

test('判断基準の目安ラベルが仕様の境界と一致する', () => {
  assert.equal(loudnessHint(-1).tone, 'danger'); // 0〜-3dB
  assert.equal(loudnessHint(-8).tone, 'warn'); // -3〜-12dB
  assert.equal(loudnessHint(-18).tone, 'ok'); // -12〜-24dB
  assert.equal(loudnessHint(-30).tone, 'low'); // -24dB未満
});

console.log('\n波形解析のユーティリティ');

test('Float32Arrayの連結', () => {
  const a = Float32Array.from([1, 2]);
  const b = Float32Array.from([3, 4, 5]);
  assert.deepEqual([...concatFloat32(a, b)], [1, 2, 3, 4, 5]);
});

test('片方が空でもそのまま返る（無駄なコピーをしない）', () => {
  const a = Float32Array.from([1, 2]);
  const empty = new Float32Array(0);
  assert.equal(concatFloat32(a, empty), a);
  assert.equal(concatFloat32(empty, a), a);
});

console.log(`\n${passed} 件通過 / ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
