/**
 * 落ちても残る作業記録。
 *
 * 重い処理の最中にタブごと落ちると、`try/catch` では何も掴めない。画面はただ
 * 読み込み直されて、開いていた動画も消える（実機で発生）。何が起きたのか分からない
 * ままになるので、**進んだところを都度 localStorage に書いておく**。
 *
 * 次に起動したとき、終わっていない記録が残っていれば「前回ここで止まった」と
 * 出せる。エラーメッセージの代わりになる唯一の手がかり。
 *
 * ワーカーからは localStorage を触れないので、書くのは常に画面側。
 * ワーカーから届いた進捗を受けて記録する。
 */
import { BUILD_ID } from './version.js';

const KEY = 'mobile-video-editor:breadcrumb';

/** 書き込みは頻繁に起きるので、この間隔より短い更新は捨てる（ミリ秒）。 */
const MIN_INTERVAL_MS = 500;

let lastWrite = 0;

/**
 * いまどこまで進んだかを記録する。
 * @param {string} task 何をしていたか（例: '文字起こし'）
 * @param {string} stage どこまで進んだか（例: '準備 62%'）
 * @param {object} [extra] 端末や設定など、あとで原因を絞るための情報
 * @param {boolean} [force] 間引きを無視して必ず書く（開始と終了で使う）
 */
export function note(task, stage, extra = {}, force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < MIN_INTERVAL_MS) return;
  lastWrite = now;
  try {
    localStorage.setItem(KEY, JSON.stringify({
      task,
      stage,
      at: now,
      build: BUILD_ID,
      memory: deviceMemoryHint(),
      ...extra,
    }));
  } catch {
    // プライベートブラウズや容量超過。記録できなくても本体の動作は続ける。
  }
}

/** 無事に終わった（あるいは自分で止めた）ので、記録を消す。 */
export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 消せなくても困らない */
  }
}

/** 前回の記録。無ければ null。 */
export function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 記録を人が読める1行にする（そのままコピーして貼れるように）。 */
export function describe(crumb) {
  if (!crumb) return '';
  const parts = [
    `${crumb.task}が「${crumb.stage}」の途中で終わっています`,
    crumb.device ? `実行方法: ${crumb.device}` : null,
    crumb.model ? `モデル: ${crumb.model}` : null,
    crumb.memory ? `端末のメモリ目安: ${crumb.memory}GB` : null,
    `版: ${crumb.build ?? '不明'}`,
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * 端末のメモリ量の目安（GB）。分からない環境では null。
 * iOSのSafariは返さないが、返る端末では原因の切り分けに効く。
 */
function deviceMemoryHint() {
  return typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number'
    ? navigator.deviceMemory
    : null;
}
