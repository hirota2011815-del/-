/**
 * 端末の機能判定。
 *
 * ステップ1の目的は「実機で書き出しが通るか」を確かめることなので、
 * 通ったか通らなかったかだけでなく、何が使えて何が使えないかを
 * 画面にそのまま出せる形で返す。
 */
import { canEncodeAudio, canEncodeVideo, canDecodeAudio, canDecodeVideo } from '../../vendor/mediabunny.min.mjs';
import { AUDIO_CODEC, VIDEO_CODEC } from './codecs.js';

/**
 * @returns {Promise<{
 *   secureContext: boolean,
 *   webCodecs: boolean,
 *   videoEncoder: boolean, audioEncoder: boolean,
 *   videoDecoder: boolean, audioDecoder: boolean,
 *   encodeH264: boolean, decodeH264: boolean,
 *   encodeAac: boolean, decodeAac: boolean,
 *   worker: boolean, wakeLock: boolean, webShareFiles: boolean,
 *   canExport: boolean, canExportAudio: boolean,
 *   verdict: 'ok'|'video-only'|'unsupported',
 * }>}
 */
export async function detectCapabilities() {
  const has = (name) => typeof globalThis[name] !== 'undefined';

  const caps = {
    secureContext: globalThis.isSecureContext === true,
    videoEncoder: has('VideoEncoder'),
    audioEncoder: has('AudioEncoder'),
    videoDecoder: has('VideoDecoder'),
    audioDecoder: has('AudioDecoder'),
    videoFrame: has('VideoFrame'),
    worker: has('Worker'),
    wakeLock: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
    webShareFiles: typeof navigator !== 'undefined' && typeof navigator.canShare === 'function',
    encodeH264: false,
    decodeH264: false,
    encodeAac: false,
    decodeAac: false,
  };
  caps.webCodecs = caps.videoEncoder && caps.videoDecoder && caps.videoFrame;

  // 実際にコーデックが通るかは宣言の有無と別なので、1080p 相当で問い合わせる。
  if (caps.webCodecs) {
    [caps.encodeH264, caps.decodeH264] = await Promise.all([
      safe(() => canEncodeVideo(VIDEO_CODEC, { width: 1920, height: 1080 })),
      safe(() => canDecodeVideo(VIDEO_CODEC, { width: 1920, height: 1080 })),
    ]);
  }
  if (caps.audioEncoder && caps.audioDecoder) {
    [caps.encodeAac, caps.decodeAac] = await Promise.all([
      safe(() => canEncodeAudio(AUDIO_CODEC, { numberOfChannels: 2, sampleRate: 48000 })),
      safe(() => canDecodeAudio(AUDIO_CODEC, { numberOfChannels: 2, sampleRate: 48000 })),
    ]);
  }

  caps.canExport = caps.secureContext && caps.encodeH264 && caps.decodeH264;
  caps.canExportAudio = caps.encodeAac && caps.decodeAac;
  caps.verdict = !caps.canExport ? 'unsupported' : caps.canExportAudio ? 'ok' : 'video-only';
  return caps;
}

async function safe(fn) {
  try {
    return await fn();
  } catch {
    return false;
  }
}

/** 画面にそのまま出す説明文。 */
export function describeCapabilities(caps) {
  const rows = [
    ['HTTPS（セキュアコンテキスト）', caps.secureContext],
    ['WebCodecs', caps.webCodecs],
    ['映像を読む（H.264デコード）', caps.decodeH264],
    ['映像を書く（H.264エンコード）', caps.encodeH264],
    ['音声を読む（AACデコード）', caps.decodeAac],
    ['音声を書く（AACエンコード）', caps.encodeAac],
    ['Web Worker', caps.worker],
    ['画面スリープ防止（Wake Lock）', caps.wakeLock],
    ['ファイル共有（保存シート）', caps.webShareFiles],
  ];
  return rows.map(([label, ok]) => ({ label, ok }));
}

/** 判定に対する一言。 */
export function verdictMessage(caps) {
  switch (caps.verdict) {
    case 'ok':
      return { tone: 'ok', text: 'この端末で書き出せます。' };
    case 'video-only':
      return {
        tone: 'warn',
        text: 'この端末では音声（AAC）を書き出せないため、映像だけのmp4になります。',
      };
    default:
      if (!caps.secureContext) {
        return {
          tone: 'error',
          text: 'httpsで開いてください。http（localhost以外）ではWebCodecsが使えません。',
        };
      }
      return {
        tone: 'error',
        text: 'この端末はWebCodecsのH.264に対応していないため、まだ書き出せません（ffmpeg.wasmへのフォールバックは後のステップで追加します）。',
      };
  }
}
