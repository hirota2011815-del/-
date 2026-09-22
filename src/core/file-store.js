/**
 * 開いた動画を端末に覚えておく。
 *
 * ブラウザは重い処理でメモリが足りなくなると、タブごと読み込み直す。そのとき
 * 開いていたファイルは消える（`<input type=file>` で選んだものは、ページの寿命しか
 * 生きていないため）。編集内容は localStorage に入っているのに、動画だけ無くなって
 * 続きができない、という状態になる。
 *
 * そこで動画そのものを IndexedDB に入れておき、次に開いたときに戻せるようにする。
 * localStorage には入らない（文字列しか置けず、容量も数MBしかない）。
 *
 * 保存は「できたらやる」扱い。容量が足りなければ黙って諦める（編集自体は続けられる）。
 */

const DB_NAME = 'mobile-video-editor';
const DB_VERSION = 1;
const STORE = 'files';
const BLOB_KEY = 'last-video';
const META_KEY = 'last-video-meta';

/** これより大きい動画は保存しない。容量を食い潰して他が壊れるほうが困るため。 */
const MAX_SAVE_BYTES = 1_000_000_000; // 1GB

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('この端末ではファイルを覚えておけません'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('開けませんでした'));
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = fn(store);
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error ?? new Error('読み書きに失敗しました'));
    tx.onabort = () => reject(tx.error ?? new Error('中断されました'));
  });
}

/**
 * 動画を覚えておく。失敗しても例外は投げない（本体の邪魔をしないため）。
 * @param {File} file
 * @returns {Promise<boolean>} 保存できたか
 */
export async function saveFile(file) {
  if (!file || file.size > MAX_SAVE_BYTES) return false;
  let db;
  try {
    db = await openDb();
    await run(db, 'readwrite', (store) => {
      store.put(file, BLOB_KEY);
      return store.put({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        savedAt: Date.now(),
      }, META_KEY);
    });
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** 覚えている動画の情報だけ（中身は読まない）。無ければ null。 */
export async function peekFile() {
  let db;
  try {
    db = await openDb();
    return (await run(db, 'readonly', (store) => store.get(META_KEY))) ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** 覚えている動画を File として取り出す。無ければ null。 */
export async function loadFile() {
  let db;
  try {
    db = await openDb();
    const [blob, meta] = await Promise.all([
      run(db, 'readonly', (store) => store.get(BLOB_KEY)),
      run(db, 'readonly', (store) => store.get(META_KEY)),
    ]);
    if (!blob) return null;
    // Fileとして戻す。名前と更新日時が同じなら、保存済みの編集リストにも当たる。
    return new File([blob], meta?.name ?? 'video.mp4', {
      type: meta?.type || blob.type || 'video/mp4',
      lastModified: meta?.lastModified ?? Date.now(),
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function clearFile() {
  let db;
  try {
    db = await openDb();
    await run(db, 'readwrite', (store) => {
      store.delete(BLOB_KEY);
      return store.delete(META_KEY);
    });
  } catch {
    /* 消せなくても困らない */
  } finally {
    db?.close();
  }
}
