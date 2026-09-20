/**
 * 書き出し中に画面が消えて処理が止まらないようにする。
 * 対応していない端末では何もしない（そのぶん「画面を閉じないで」の表示で補う）。
 */
let sentinel = null;

export async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    // タブに戻ってきたら取り直す。
    document.addEventListener('visibilitychange', reacquire);
    return true;
  } catch {
    return false;
  }
}

async function reacquire() {
  if (document.visibilityState !== 'visible' || !sentinel || !sentinel.released) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
  } catch {
    /* 取り直せなければ諦める */
  }
}

export async function releaseWakeLock() {
  document.removeEventListener('visibilitychange', reacquire);
  try {
    await sentinel?.release();
  } catch {
    /* 解放できなくても実害はない */
  }
  sentinel = null;
}
