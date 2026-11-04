// 録画したクリップの確認用：指定した秒のコマを PNG に書き出す（ffmpeg なしで、Chromium の <video> で再生して撮る）
//   npx tsx video/capture/contact-sheet.ts video/public/captures/a-register.webm 出力フォルダ [秒 ...]

import { mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [file, outDir, ...times] = process.argv.slice(2);
if (!file || !outDir) throw new Error('使い方: contact-sheet.ts <webm> <出力フォルダ> [秒 ...]');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const b64 = readFileSync(resolve(file)).toString('base64');
await page.setContent(`<body style="margin:0;background:#000"><video id="v" muted style="width:1920px;height:1080px;display:block"></video></body>`);
const duration = await page.evaluate(async (src) => {
  const v = document.getElementById('v') as HTMLVideoElement;
  const blob = await (await fetch(`data:video/webm;base64,${src}`)).blob();
  v.src = URL.createObjectURL(blob);
  await new Promise((r) => (v.onloadedmetadata = r));
  return v.duration;
}, b64);
const ts = times.length ? times.map(Number) : [0, 0.25, 0.5, 0.75, 0.98].map((k) => +(duration * k).toFixed(2));
for (const t of ts) {
  await page.evaluate((t) => new Promise((r) => { const v = document.getElementById('v') as HTMLVideoElement; v.onseeked = r; v.currentTime = t; }), t);
  await page.screenshot({ path: join(outDir, `${basename(file, '.webm')}-${t.toFixed(1)}s.png`) });
}
console.log(`${file}: ${duration.toFixed(2)}秒、${ts.join(', ')} 秒のコマを ${outDir} に書き出した`);
await browser.close();
