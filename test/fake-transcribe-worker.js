/**
 * テスト用の偽ワーカー。
 *
 * WebGPUで落ちたあと、新しいワーカーでWASMを指定してやり直す道筋を確かめるためのもの。
 * 本物のモデルは読まず、受け取った forceDevice を見て返事を変えるだけ。
 *
 * `__fakeMode` で振る舞いを切り替える:
 *   'webgpu-fails' … forceDevice が無いときはWebGPUの失敗を返し、'wasm' なら成功する
 *   'always-fails' … 何を指定されても失敗する（やり直しが無限に続かないことの確認）
 */
let calls = 0;

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type !== 'transcribe') return;
  calls += 1;

  if (msg.mode === 'always-fails') {
    self.postMessage({ type: 'error', message: 'どうやっても駄目', device: 'webgpu' });
    return;
  }

  if (!msg.forceDevice) {
    self.postMessage({ type: 'error', message: 'WebGPUで失敗', device: 'webgpu' });
    return;
  }

  self.postMessage({ type: 'progress', phase: 'transcribe', ratio: 0, detail: `1/1 区間目` });
  self.postMessage({
    type: 'done',
    segments: [{ start: 0, end: 1, text: `${msg.forceDevice}で成功` }],
  });
};
