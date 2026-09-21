/**
 * 波形解析ワーカー。UIスレッドを止めないため、デコードはここで行う。
 */
import { analyzeWaveform, WaveformCanceled } from './waveform.js';

let canceled = false;

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === 'cancel') {
    canceled = true;
    return;
  }

  if (msg.type !== 'analyze') return;
  canceled = false;

  try {
    const result = await analyzeWaveform(
      msg.file,
      (chunk) => {
        self.postMessage(
          {
            type: 'chunk',
            ratio: chunk.ratio,
            peaksSlice: chunk.peaksSlice,
            rmsSlice: chunk.rmsSlice,
            sampleRate: chunk.sampleRate,
            bucketFrames: chunk.bucketFrames,
          },
          [chunk.peaksSlice.buffer, chunk.rmsSlice.buffer],
        );
      },
      () => canceled,
    );
    if (!result) {
      self.postMessage({ type: 'done', empty: true });
      return;
    }
    self.postMessage({
      type: 'done',
      empty: false,
      sampleRate: result.sampleRate,
      bucketFrames: result.bucketFrames,
      channels: result.channels,
      duration: result.duration,
      totalBuckets: result.peaks.length,
    });
  } catch (err) {
    if (err instanceof WaveformCanceled || err?.name === 'WaveformCanceled') {
      self.postMessage({ type: 'canceled' });
      return;
    }
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
