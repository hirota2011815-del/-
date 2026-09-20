/**
 * プレビュー。動画は変換せず、<video> の再生位置をクリップ順に飛ばして見せる。
 *
 * 除外されたクリップは飛ばし、クリップごとの速度は playbackRate で反映する。
 * timeupdate は 1秒に4回程度しか来ず、それだとクリップの境目を最大250msも
 * 行き過ぎてしまうので、再生中は requestAnimationFrame で見張る。
 */
export class ClipPlayer extends EventTarget {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    super();
    this.video = video;
    this.list = null;
    /** 直前に適用したクリップ。切り替わったときだけ速度を差し替える。 */
    this.currentClipId = null;
    this.seeking = false;
    this.rafId = 0;

    video.addEventListener('timeupdate', () => this.#tick());
    video.addEventListener('seeked', () => {
      this.seeking = false;
      this.#tick();
    });
    video.addEventListener('play', () => {
      this.#startWatching();
      this.#emit('statechange');
    });
    video.addEventListener('pause', () => {
      this.#stopWatching();
      this.#emit('statechange');
    });
    video.addEventListener('ended', () => this.#stopWatching());
  }

  setEditList(list) {
    this.list = list;
    this.currentClipId = null;
    this.#tick();
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get playing() {
    return !this.video.paused && !this.video.ended;
  }

  async togglePlay() {
    if (this.playing) {
      this.video.pause();
      return;
    }
    const clips = this.#enabled();
    if (clips.length === 0) return;
    // 終端で押されたら頭から。
    const last = clips.at(-1);
    if (this.video.currentTime >= last.out - 0.05) {
      this.seekSource(clips[0].in);
    }
    try {
      await this.video.play();
    } catch {
      /* 自動再生が拒否されたら何もしない */
    }
  }

  /** 元動画の時刻へ移動する。除外区間に落ちたら次の有効クリップの頭へ寄せる。 */
  seekSource(t) {
    const clips = this.#enabled();
    if (clips.length === 0) return;
    const target = this.#snapToEnabled(t, clips);
    if (Math.abs(this.video.currentTime - target) < 0.005) return;
    this.seeking = true;
    this.video.currentTime = target;
    this.#applySpeedFor(target, clips);
    this.#emit('timeupdate');
  }

  #startWatching() {
    if (this.rafId) return;
    const loop = () => {
      if (!this.playing) {
        this.rafId = 0;
        return;
      }
      this.#tick();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  #stopWatching() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.#emit('timeupdate');
  }

  #snapToEnabled(t, clips) {
    for (const clip of clips) {
      if (t < clip.in) return clip.in;
      if (t < clip.out) return t;
    }
    return Math.max(0, clips.at(-1).out - 0.01);
  }

  #enabled() {
    if (!this.list) return [];
    return this.list.clips.filter((c) => c.enabled && c.out - c.in > 0);
  }

  #tick() {
    const clips = this.#enabled();
    if (clips.length === 0) {
      this.video.pause();
      this.#emit('timeupdate');
      return;
    }
    const t = this.video.currentTime;
    const inside = clips.some((c) => t >= c.in && t < c.out);

    if (!inside && !this.seeking) {
      // クリップの外に出た。次の有効クリップへ飛ぶか、終端なら止める。
      const next = clips.find((c) => c.in > t);
      if (next) {
        this.seeking = true;
        this.video.currentTime = next.in;
        this.#applySpeedFor(next.in, clips);
      } else {
        this.video.pause();
        this.video.currentTime = clips.at(-1).out;
      }
    } else if (inside) {
      this.#applySpeedFor(t, clips);
    }
    this.#emit('timeupdate');
  }

  #applySpeedFor(t, clips) {
    const clip = clips.find((c) => t >= c.in && t < c.out) ?? clips[0];
    if (clip.id === this.currentClipId) return;
    this.currentClipId = clip.id;
    this.video.playbackRate = clip.speed;
    this.#emit('clipchange', { clipId: clip.id });
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
