/**
 * 書き出しに使うコーデック。mp4 に入れる前提で固定。
 * （ここだけ差し替えられるようにしてあるのは、ヘッドレスChromiumが
 *   H.264/AAC を持たないため、自動テストで VP9/Opus に置き換えるから）
 */
export const VIDEO_CODEC = 'avc'; // H.264
export const AUDIO_CODEC = 'aac';
