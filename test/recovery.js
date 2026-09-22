/**
 * 落ちたあとの復帰まわりの検証。
 *
 * 実機で、文字起こしの最中にタブごと読み込み直され、開いていた動画が消えた。
 * その対策として入れた2つを確かめる。
 *
 *  - 作業記録（localStorage）… 落ちても残るので「どこで止まったか」が分かる
 *  - 動画の保管（IndexedDB）… 読み込み直されても開き直せる
 *
 * どちらも失敗しても本体が止まらないこと（容量不足などで黙って諦めること）も見る。
 */
import { clear as clearCrumb, describe, note, read } from '../src/core/breadcrumb.js';
import { clearFile, loadFile, peekFile, saveFile } from '../src/core/file-store.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

export async function runRecoverySuite() {
  results.length = 0;

  /* --- 作業記録 --- */
  clearCrumb();
  check('記録が無ければ null', read() === null);

  note('文字起こし', '準備 40%', { model: 'tiny', device: 'wasm' }, true);
  const crumb = read();
  check('記録が残る', crumb?.stage === '準備 40%', JSON.stringify(crumb));
  check('版も一緒に残る（どのビルドで起きたか分かるように）', typeof crumb?.build === 'string', crumb?.build);

  const line = describe(crumb);
  check('人が読める1行になる',
    line.includes('文字起こし') && line.includes('準備 40%') && line.includes('wasm'), line);

  // 書き込みは進捗のたびに来るので、間引いていないと重くなる
  note('文字起こし', '準備 41%');
  check('短い間隔の更新は間引かれる', read().stage === '準備 40%', read().stage);
  note('文字起こし', '準備 90%', {}, true);
  check('強制指定なら必ず書かれる', read().stage === '準備 90%', read().stage);

  clearCrumb();
  check('終わったら記録は消える', read() === null);

  /* --- 動画の保管 --- */
  await clearFile();
  check('保管が空なら null', (await peekFile()) === null);

  const bytes = new Uint8Array(2048).map((_, i) => i % 251);
  const original = new File([bytes], 'テスト動画.mp4', { type: 'video/mp4', lastModified: 1_700_000_000_000 });

  check('動画を保管できる', (await saveFile(original)) === true);

  const meta = await peekFile();
  check('中身を読まずに名前と大きさが分かる',
    meta?.name === 'テスト動画.mp4' && meta?.size === 2048, JSON.stringify(meta));

  const restored = await loadFile();
  check('Fileとして取り出せる', restored instanceof File, String(restored));
  check('名前が保たれる', restored?.name === 'テスト動画.mp4', restored?.name);
  // 保存済みの編集リストは名前・大きさ・更新日時で引くので、ここが変わると続きから開けない
  check('更新日時が保たれる（編集の続きを引き当てるのに要る）',
    restored?.lastModified === 1_700_000_000_000, String(restored?.lastModified));

  const readBack = new Uint8Array(await restored.arrayBuffer());
  check('中身が変わっていない',
    readBack.length === bytes.length && readBack.every((v, i) => v === bytes[i]),
    `${readBack.length}バイト`);

  await clearFile();
  check('消せる', (await peekFile()) === null);

  /* --- 大きすぎる動画は保管しない（容量を食い潰さないため） --- */
  const huge = { size: 2_000_000_000, name: 'huge.mp4', type: 'video/mp4', lastModified: 0 };
  check('大きすぎる動画は保管しない', (await saveFile(huge)) === false);
  check('保管しなかったものは残らない', (await peekFile()) === null);

  // あとの検証に影響しないよう片付ける
  clearCrumb();
  await clearFile();

  return results;
}
