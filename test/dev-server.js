/**
 * 手元で動かすための静的サーバ。
 *
 *   npm run dev      → http://localhost:5173
 *
 * スマホの実機で試すときは、同じWi-Fiから http://<PCのIP>:5173 を開く。
 * ただし WebCodecs は https か localhost でしか動かないので、実機確認は
 * Cloudflare Pages などに置くか、トンネル（cloudflared / ngrok）を通すこと。
 */
import { serve } from './serve.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5173;

const { port } = await serve(ROOT, PORT);
console.log(`http://localhost:${port}/ で配信中（Ctrl+C で終了）`);
