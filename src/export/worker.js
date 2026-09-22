/**
 * 書き出しワーカー。
 *
 * デコードとエンコードをUIスレッドから逃がす。長尺でもタイムラインの操作や
 * 進捗表示が固まらないようにするため。
 */
import { ExportCanceled, runExport } from './pipeline.js';

let canceled = false;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    canceled = true;
    return;
  }

  if (msg.type !== 'export') return;
  canceled = false;

  try {
    const result = await runExport({
      file: msg.file,
      editList: msg.editList,
      quality: msg.quality,
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
      isCanceled: () => canceled,
    });
    self.postMessage({ type: 'done', result }, [result.buffer]);
  } catch (err) {
    self.postMessage({
      type: 'error',
      canceled: err instanceof ExportCanceled || err?.name === 'ExportCanceled',
      message: err?.message ?? String(err),
      stack: err?.stack ?? '',
    });
  }
};
