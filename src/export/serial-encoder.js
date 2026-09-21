/**
 * 書き出しが「タイムスタンプの巻き戻り」で止まったときの逃げ道。
 *
 * ## なぜ必要か
 * H.264のエンコーダは圧縮効率のため、フレームを内部で溜めて並べ替えることがある
 * （Bフレーム）。並べ替えたフレームがキーフレームをまたぐと、表示順では前に来る
 * フレームがキーフレームより後から出てくる。mp4に詰める側にはそれを受け付けない
 * 検査があり、書き出しが止まる。
 *
 * 通常は「クリップの切れ目を明示的にキーフレームにする」ことでこれを避けている
 * （明示要求したキーフレームは、それより前のフレームを出し切ってから作られる）。
 * ただしエンコーダが自分の判断で差し込むキーフレームまでは抑えられないため、
 * それでも止まった場合の最後の手段としてこのエンコーダを使う。
 *
 * ## やっていること
 * 1フレームごとに `flush()` して出し切る。エンコーダが次のフレームを待って
 * 溜め込むことができなくなるので、並べ替えは起きようがない。
 * 総当たりなぶん遅くなるが、Pフレームは使えるのでファイルサイズは普通のまま。
 *
 * 既定では無効。`serialEncoding.enabled` を立てたときだけ使われる。
 */
import { CustomVideoEncoder, EncodedPacket, registerEncoder } from '../../vendor/mediabunny.min.mjs';

/** フォールバック時だけ立てる。通常の書き出しは素のエンコーダに任せる。 */
export const serialEncoding = { enabled: false };

class SerialVideoEncoder extends CustomVideoEncoder {
  static supports() {
    return serialEncoding.enabled && typeof VideoEncoder !== 'undefined';
  }

  async init() {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.onPacket(EncodedPacket.fromEncodedChunk(chunk), meta),
      error: (error) => this.onError(error),
    });
    this.encoder.configure(this.config);
  }

  async encode(videoSample, options) {
    const frame = videoSample.toVideoFrame();
    try {
      this.encoder.encode(frame, options);
    } finally {
      frame.close();
    }
    // 1フレームずつ出し切る。ここが並べ替えを封じている要。
    await this.encoder.flush();
  }

  async flush() {
    await this.encoder.flush();
  }

  async close() {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}

registerEncoder(SerialVideoEncoder);

/** このエラーのときだけフォールバックする価値がある。 */
export function isTimestampOrderError(error) {
  return /largest timestamp of the previous GOP/i.test(error?.message ?? '');
}
