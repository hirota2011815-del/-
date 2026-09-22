/**
 * 速度変更ぶんの音声リサンプラ。
 *
 * ピッチは保持しない（速度なりの声になる）ので、やることは
 * 「入力を `speed` 倍の歩幅で読み進めて線形補間する」だけ。
 * 将来ピッチ保持を足すときは、このクラスを差し替える場所になる。
 *
 * 長尺でメモリを抱えないよう、入ってきたぶんだけ処理して、
 * 次の補間に必要な数フレームだけを手元に残す。
 */
export class LinearResampler {
  /**
   * @param {number} channels チャンネル数
   * @param {number} speed 再生速度（1 なら素通し）
   */
  constructor(channels, speed) {
    this.channels = channels;
    this.speed = speed;
    /** @type {Float32Array[]} チャンネルごとの未消化サンプル */
    this.pending = Array.from({ length: channels }, () => new Float32Array(0));
    /** pending の先頭が入力全体の何フレーム目か */
    this.offset = 0;
    /** 次に読み出す位置（入力フレーム単位、小数） */
    this.position = 0;
  }

  /**
   * 入力をチャンネルごとの平面データで受け取り、出せるぶんだけ出力を返す。
   * @param {Float32Array[]} planes チャンネルごとの Float32Array（長さは揃っていること）
   * @returns {Float32Array[]} チャンネルごとの出力（0 フレームのこともある）
   */
  push(planes) {
    this.#append(planes);
    const available = this.offset + this.pending[0].length;
    // 線形補間には position の左右 2 サンプルが要る。
    const count = Math.max(0, Math.floor((available - 1 - this.position) / this.speed) + 1);
    return this.#emit(count, false);
  }

  /**
   * 入力の終わりで、手元に残ったぶんを吐き出す。
   * @returns {Float32Array[]}
   */
  flush() {
    const available = this.offset + this.pending[0].length;
    const count = Math.max(0, Math.ceil((available - this.position) / this.speed));
    const out = this.#emit(count, true);
    this.pending = this.pending.map(() => new Float32Array(0));
    return out;
  }

  #append(planes) {
    for (let ch = 0; ch < this.channels; ch += 1) {
      const incoming = planes[ch] ?? new Float32Array(planes[0].length);
      const prev = this.pending[ch];
      const merged = new Float32Array(prev.length + incoming.length);
      merged.set(prev, 0);
      merged.set(incoming, prev.length);
      this.pending[ch] = merged;
    }
  }

  #emit(count, isFlush) {
    if (count <= 0) return this.pending.map(() => new Float32Array(0));

    const out = Array.from({ length: this.channels }, () => new Float32Array(count));
    const maxIndex = this.pending[0].length - 1;

    for (let i = 0; i < count; i += 1) {
      const pos = this.position + i * this.speed;
      const base = Math.floor(pos);
      const frac = pos - base;
      // flush のときだけ末尾を越えうるので、両端で止める。
      const a = Math.min(Math.max(base - this.offset, 0), maxIndex);
      const b = Math.min(a + 1, maxIndex);
      for (let ch = 0; ch < this.channels; ch += 1) {
        const src = this.pending[ch];
        out[ch][i] = src[a] + (src[b] - src[a]) * frac;
      }
    }

    this.position += count * this.speed;

    if (!isFlush) {
      // まだ補間に要る 1 サンプル手前まで捨てる。
      const keepFrom = Math.max(0, Math.floor(this.position) - this.offset);
      if (keepFrom > 0) {
        for (let ch = 0; ch < this.channels; ch += 1) {
          this.pending[ch] = this.pending[ch].slice(keepFrom);
        }
        this.offset += keepFrom;
      }
    }
    return out;
  }
}
