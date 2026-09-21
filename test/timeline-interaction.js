/**
 * Timelineクラスの操作テスト（タップ／ドラッグ・ピンチ・トリム・ダブルタップ）。
 *
 * 実際のタッチではなく、Canvas要素に合成の PointerEvent を送って確かめる。
 * Timeline は 'pointerdown'/'pointermove'/'pointerup' しか見ていないので、
 * これで実機のジェスチャーと同じコードパスを通せる。
 */
import { Timeline } from '../src/ui/timeline.js';
import { createEditList, splitAt } from '../src/core/edit-list.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

/** テスト用に、getBoundingClientRect が固定サイズを返すcanvasを用意する。 */
function makeCanvas(width = 300, height = 72) {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0,
  });
  return canvas;
}

function fire(canvas, type, { id = 1, x, y = 10 }) {
  canvas.dispatchEvent(new PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}

export function runInteractionSuite() {
  results.length = 0;

  /* --- タップでシーク --- */
  {
    const canvas = makeCanvas();
    const timeline = new Timeline(canvas);
    timeline.setEditList(createEditList('a.mp4', 30));
    timeline.width = 300; timeline.height = 72; // resize()を待たずテストで直接固定する

    let seekTime = null;
    timeline.addEventListener('seek', (e) => { seekTime = e.detail.time; });
    fire(canvas, 'pointerdown', { x: 150 });
    fire(canvas, 'pointerup', { x: 150 });

    check('タップで対応する時刻にシークする', Math.abs(seekTime - 15) < 0.5, `${seekTime}`);
    canvas.remove();
  }

  /* --- ドラッグでスクラブ（連続シーク） --- */
  {
    const canvas = makeCanvas();
    const timeline = new Timeline(canvas);
    timeline.setEditList(createEditList('a.mp4', 30));
    timeline.width = 300; timeline.height = 72;

    const seeks = [];
    timeline.addEventListener('seek', (e) => seeks.push(e.detail.time));
    fire(canvas, 'pointerdown', { x: 30 });
    fire(canvas, 'pointermove', { x: 90 });
    fire(canvas, 'pointermove', { x: 180 });
    fire(canvas, 'pointerup', { x: 180 });

    check('ドラッグ中は複数回シークイベントが飛ぶ', seeks.length >= 3, `${seeks.length}回`);
    check('ドラッグに合わせてシーク時刻も進む', seeks.at(-1) > seeks[0], seeks.join(','));
    canvas.remove();
  }

  /* --- ピンチでズーム --- */
  {
    const canvas = makeCanvas();
    const timeline = new Timeline(canvas);
    timeline.setEditList(createEditList('a.mp4', 60));
    timeline.width = 300; timeline.height = 72;

    const before = timeline.viewWindow.duration;
    // 中心付近で2本指を開く（狭い間隔→広い間隔）
    fire(canvas, 'pointerdown', { id: 1, x: 140 });
    fire(canvas, 'pointerdown', { id: 2, x: 160 });
    fire(canvas, 'pointermove', { id: 1, x: 90 });
    fire(canvas, 'pointermove', { id: 2, x: 210 });
    const after = timeline.viewWindow.duration;

    check('ピンチで指を開くとズームインして表示時間が短くなる', after < before, `${before} → ${after}`);

    fire(canvas, 'pointerup', { id: 1, x: 90 });
    fire(canvas, 'pointerup', { id: 2, x: 210 });
    canvas.remove();
  }

  /* --- ダブルタップでズーム解除 --- */
  {
    const canvas = makeCanvas();
    const timeline = new Timeline(canvas);
    timeline.setEditList(createEditList('a.mp4', 60));
    timeline.width = 300; timeline.height = 72;
    timeline.viewStart = 10;
    timeline.viewDuration = 5; // 手動でズームさせておく

    fire(canvas, 'pointerdown', { x: 100 });
    fire(canvas, 'pointerup', { x: 100 });
    fire(canvas, 'pointerdown', { x: 102 });
    fire(canvas, 'pointerup', { x: 102 });

    const view = timeline.viewWindow;
    check(
      'ダブルタップで全体表示（0〜全長）に戻る',
      view.start === 0 && Math.abs(view.duration - 60) < 1e-9,
      JSON.stringify(view),
    );
    canvas.remove();
  }

  /* --- 選択中クリップの端をドラッグしてトリム --- */
  {
    const canvas = makeCanvas();
    const timeline = new Timeline(canvas);
    const split = splitAt(createEditList('a.mp4', 30), 15);
    timeline.setEditList(split.list);
    timeline.width = 300; timeline.height = 72;
    const secondClipId = split.newClipId;
    timeline.setSelected(secondClipId);

    // 境界(15秒 → x=150)のすぐ近くを掴んで、10秒(x=100)相当まで動かす
    const trims = [];
    timeline.addEventListener('trim', (e) => trims.push(e.detail));
    fire(canvas, 'pointerdown', { x: 152 });
    fire(canvas, 'pointermove', { x: 100 });
    fire(canvas, 'pointerup', { x: 100 });

    check('端の近くを掴むとtrimイベントが飛ぶ', trims.length > 0, `${trims.length}件`);
    if (trims.length > 0) {
      check('選択中クリップのinエッジが対象になる', trims[0].clipId === secondClipId && trims[0].edge === 'in');
      check('トリム後の時刻がドラッグ位置に近い', Math.abs(trims.at(-1).time - 10) < 0.5, `${trims.at(-1).time}`);
    }
    canvas.remove();
  }

  /* --- 選択中クリップの手が届かない境界は掴めない（誤操作防止） --- */
  {
    const canvas = makeCanvas();
    const timeline = new Timeline(canvas);
    let list = createEditList('a.mp4', 30);
    list = splitAt(list, 10).list; // 0-10, 10-30
    list = splitAt(list, 20).list; // 0-10, 10-20, 20-30
    timeline.setEditList(list);
    timeline.width = 300; timeline.height = 72;
    timeline.setSelected(list.clips[0].id); // 選択は1つ目(0-10)。境界20秒(x=200)はその手のハンドルではない

    let trimmed = false;
    let seeked = false;
    timeline.addEventListener('trim', () => { trimmed = true; });
    timeline.addEventListener('seek', () => { seeked = true; });
    fire(canvas, 'pointerdown', { x: 202 }); // 2つ目と3つ目の境界のすぐ近く
    fire(canvas, 'pointerup', { x: 202 });

    check('選択中クリップの手が届かない境界を触ってもtrimは発生せずシークになる', !trimmed && seeked);
    canvas.remove();
  }

  return results;
}
