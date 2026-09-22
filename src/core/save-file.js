/**
 * 書き出した mp4 を端末に残す。
 *
 * スマホでは「共有シート」から写真アプリやファイルアプリへ入れるのがいちばん確実なので、
 * 使えるならそれを先に出し、使えなければダウンロードにする。
 */

/** 元ファイル名から、書き出し後のファイル名を作る。 */
export function outputFileName(sourceName) {
  const base = (sourceName || 'video').replace(/\.[^.]+$/, '');
  const stamp = new Date()
    .toISOString()
    .slice(0, 16)
    .replace(/[-:]/g, '')
    .replace('T', '-');
  return `${base}_edit_${stamp}.mp4`;
}

/** 共有シートにファイルを渡せるか。 */
export function canShareFile(file) {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * 共有シートを開く。
 * @returns {Promise<'shared'|'canceled'|'unavailable'>}
 */
export async function shareFile(file) {
  if (!canShareFile(file)) return 'unavailable';
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'canceled';
    return 'unavailable';
  }
}

/** ダウンロードとして保存する。 */
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Safari が読み終わる前に revoke すると落ちるので、少し待ってから開放する。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
