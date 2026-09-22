/**
 * 字幕パネルの操作テスト。
 *
 * 実機のタップの代わりにボタンを click() し、パネルが出すイベントと
 * プレビューの重ね表示が正しく変わるかを確かめる。
 */
import { SubtitlePanel } from '../src/ui/subtitle-editor.js';
import { defaultSubtitleStyle, findPreset } from '../src/subtitles/styles.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
}

/** パネルが使う要素一式を作る。 */
function makeDom() {
  const root = document.createElement('div');
  document.body.append(root);
  const make = (tag = 'div') => {
    const e = document.createElement(tag);
    root.append(e);
    return e;
  };
  const overlay = make();
  const overlayText = document.createElement('span');
  overlay.append(overlayText);
  return {
    root,
    overlay,
    overlayText,
    video: make('video'),
    schemes: make(),
    fonts: make(),
    positions: make(),
    sizes: make(),
    current: make(),
    list: make(),
  };
}

function makePanel({ subtitles = [], duration = 30 } = {}) {
  const dom = makeDom();
  const panel = new SubtitlePanel(dom);
  const events = { change: [], stylechange: [], seek: [] };
  for (const type of Object.keys(events)) {
    panel.addEventListener(type, (e) => events[type].push(e.detail));
  }
  panel.setState({ subtitles, style: defaultSubtitleStyle(), duration, enabled: true });
  return { dom, panel, events };
}

/** チップの並びから、表示文字が一致するものを押す。 */
function clickChip(container, label) {
  for (const chip of container.children) {
    if (chip.textContent.includes(label)) {
      chip.click();
      return true;
    }
  }
  return false;
}

export function runSubtitlePanelSuite() {
  results.length = 0;

  /* --- 追加 --- */
  {
    const { dom, panel, events } = makePanel();
    panel.setSourceTime(5);
    check('字幕が無いときは追加ボタンが出る', dom.current.querySelector('button') !== null);

    dom.current.querySelector('button').click();
    check('追加すると1行できる', events.change.at(-1)?.subtitles.length === 1);
    check(
      '追加した字幕はいまの位置から始まる',
      Math.abs(events.change.at(-1).subtitles[0].start - 5) < 1e-6,
      `${events.change.at(-1)?.subtitles[0]?.start}`,
    );
    check('追加するとテキスト欄に変わる', dom.current.querySelector('textarea') !== null);
  }

  /* --- 文字の入力とプレビュー --- */
  {
    const { dom, panel, events } = makePanel({ subtitles: [{ id: 's1', start: 1, end: 3, text: 'もと' }] });
    panel.setSourceTime(2);

    const area = dom.current.querySelector('textarea');
    check('いま出ている字幕がテキスト欄に入る', area?.value === 'もと', area?.value);
    check('プレビューに字幕が出る', dom.overlay.hidden === false && dom.overlayText.textContent === 'もと');

    area.value = 'なおした';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    check('入力が編集リストへ伝わる', events.change.at(-1)?.subtitles[0].text === 'なおした');
    check('入力がプレビューにも出る', dom.overlayText.textContent === 'なおした');
    check(
      '入力中にテキスト欄が作り直されない',
      dom.current.querySelector('textarea') === area,
      '差し替わるとカーソルが飛ぶ',
    );
    check('一覧の文字も追いつく', dom.list.textContent.includes('なおした'));

    panel.setSourceTime(5);
    check('字幕が出ていない位置ではプレビューが消える', dom.overlay.hidden === true);
    check('字幕が出ていない位置ではテキスト欄も消える', dom.current.querySelector('textarea') === null);
  }

  /* --- 見た目 --- */
  {
    const { dom, panel, events } = makePanel({ subtitles: [{ id: 's1', start: 0, end: 5, text: 'あ' }] });
    panel.setSourceTime(1);
    const before = findPreset(defaultSubtitleStyle().preset);

    check('配色が6つ並ぶ', dom.schemes.children.length === 6, `${dom.schemes.children.length}`);
    check('書体が4つ並ぶ', dom.fonts.children.length === 4, `${dom.fonts.children.length}`);
    check('位置が3つ並ぶ', dom.positions.children.length === 3);
    check('大きさが3つ並ぶ', dom.sizes.children.length === 3);

    clickChip(dom.schemes, '黄・黒フチ');
    const afterScheme = findPreset(events.stylechange.at(-1).style.preset);
    check(
      '配色を変えても書体は変わらない',
      afterScheme.scheme.id === 'yellow' && afterScheme.font.id === before.font.id,
      events.stylechange.at(-1)?.style.preset,
    );

    clickChip(dom.fonts, '明朝');
    const afterFont = findPreset(events.stylechange.at(-1).style.preset);
    check(
      '書体を変えても配色は変わらない',
      afterFont.font.id === 'mincho' && afterFont.scheme.id === 'yellow',
      events.stylechange.at(-1)?.style.preset,
    );
    check('配色がプレビューの色に反映される', dom.overlayText.style.color.replace(/\s/g, '') === 'rgb(255,225,77)', dom.overlayText.style.color);

    clickChip(dom.positions, '上');
    check('位置がプレビューに反映される', dom.overlay.dataset.position === 'top', dom.overlay.dataset.position);

    const small = dom.overlayText.style.fontSize;
    clickChip(dom.sizes, '大');
    check('大きさを変えると文字が大きくなる', parseFloat(dom.overlayText.style.fontSize) > parseFloat(small), `${small} → ${dom.overlayText.style.fontSize}`);
  }

  /* --- 一覧と時刻の微調整・削除 --- */
  {
    const { dom, panel, events } = makePanel({
      subtitles: [
        { id: 's1', start: 1, end: 3, text: '1行目' },
        { id: 's2', start: 4, end: 6, text: '2行目' },
      ],
    });
    panel.setSourceTime(2);

    check('一覧に2行出る', dom.list.children.length === 2, `${dom.list.children.length}`);
    check('いま出ている行に印が付く', dom.list.children[0].classList.contains('is-active'));

    dom.list.children[1].click();
    check('行を選ぶとその位置へ飛ぶ', Math.abs(events.seek.at(-1).time - 4) < 0.05, `${events.seek.at(-1)?.time}`);

    // 始まりを0.1秒早める（◀ を押す）
    const back = [...dom.current.querySelectorAll('button')].find((b) => b.textContent === '◀');
    back.click();
    check(
      '◀で始まりが0.1秒早まる',
      Math.abs(events.change.at(-1).subtitles[0].start - 0.9) < 1e-6,
      `${events.change.at(-1)?.subtitles[0]?.start}`,
    );

    // 端を動かして再生位置が字幕の外に出たら、位置のほうを中へ連れ戻す
    const forward = [...dom.current.querySelectorAll('button')].find((b) => b.textContent === '▶');
    panel.setSourceTime(0.95);
    forward.click(); // 始まりを 0.9 → 1.0 へ
    check(
      '端を動かして外に出たら再生位置が追いかける',
      dom.current.querySelector('textarea') !== null && events.seek.at(-1).time > 0.95,
      `${events.seek.at(-1)?.time}`,
    );

    panel.setSourceTime(2);
    const remove = [...dom.current.querySelectorAll('button')].find((b) => b.textContent.includes('消す'));
    remove.click();
    check('消すと一覧から減る', events.change.at(-1).subtitles.length === 1 && dom.list.children.length === 1);
    check('消した後はプレビューからも消える', dom.overlay.hidden === true);
  }

  /* --- 動画を開く前 --- */
  {
    const dom = makeDom();
    const panel = new SubtitlePanel(dom);
    panel.setState({ subtitles: [], style: defaultSubtitleStyle(), duration: 0, enabled: false });
    check('動画を開く前でも見た目は選べる形で並ぶ', dom.schemes.children.length === 6);
    check('動画を開く前は追加できない', dom.current.querySelector('button')?.disabled === true);
  }

  return results;
}
