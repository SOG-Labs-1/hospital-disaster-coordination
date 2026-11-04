// 使い方: OUT_DIR=video/public node video/scripts/narration.mjs <声の名前 例 Charon> [speakingRate]
// APIキーはリポジトリの .env の GOOGLE_TTS_API_KEY から読む（表示しない）
// 文ごとに音声を作り、決めた長さの無音をはさんで1本の WAV にする
import { writeFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
process.loadEnvFile(`${repo}/.env`);
const key = process.env.GOOGLE_TTS_API_KEY;
if (!key) { console.error('GOOGLE_TTS_API_KEY が .env にありません'); process.exit(1); }
const [, , voice = 'Charon', rateArg] = process.argv;
const speakingRate = Number(rateArg ?? 0.95);
const rate = 48000;

// [文, 後ろの無音（秒）]
const lines = [
  ['地震、豪雨、台風。', 0.6],
  ['災害のたび、病院に患者が押し寄せる。', 1.0],
  ['患者は、人は、物は、どこにいるのか。', 0.6],
  ['院内の状況は、つかみきれない。', 1.0],
  ['日々の業務に追われ、訓練もままならない。', 1.4],
  ['タシカメ。', 0.8],
  ['災害時の院内調整と、エーアイと行う、平常時の訓練。', 1.0],
  ['総合病院から、中規模病院まで。', 0.5],
  ['安全で効率的な災害対応を、実現する。', 0.8],
];

async function synth(text) {
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ja-JP', name: `ja-JP-Chirp3-HD-${voice}` },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: rate, speakingRate },
    }),
  });
  if (!r.ok) { console.error(`失敗 ${r.status}: ${(await r.text()).slice(0, 400)}`); process.exit(1); }
  return Buffer.from((await r.json()).audioContent, 'base64');
}
// 文の前後の無音を削る（振幅が小さい部分）。少しだけ余白を残す
function trim(buf) {
  const n = buf.length / 2, th = 300, keep = Math.round(0.04 * rate);
  let a = 0, b = n - 1;
  while (a < n && Math.abs(buf.readInt16LE(a * 2)) < th) a++;
  while (b > a && Math.abs(buf.readInt16LE(b * 2)) < th) b--;
  return buf.subarray(Math.max(0, a - keep) * 2, Math.min(n, b + keep) * 2);
}
function pcm(wav) {
  let o = 12;
  while (o < wav.length) {
    const id = wav.toString('ascii', o, o + 4), size = wav.readUInt32LE(o + 4);
    if (id === 'data') return wav.subarray(o + 8, Math.min(wav.length, o + 8 + size));
    o += 8 + size;
  }
  throw new Error('no data chunk');
}
const parts = [];
const timings = [];
let pos = 0;
for (const [t, pause] of lines) {
  const v = trim(Buffer.from(pcm(await synth(t))));
  timings.push({ text: t.replace('エーアイ', 'AI'), start: +(pos / 2 / rate).toFixed(3), end: +((pos + v.length) / 2 / rate).toFixed(3) });
  parts.push(v); pos += v.length;
  const silence = Buffer.alloc(Math.round(pause * rate) * 2);
  parts.push(silence); pos += silence.length;
}
const outDir = process.env.OUT_DIR;
if (outDir) writeFileSync(`${outDir}/narration.json`, JSON.stringify({ voice: `ja-JP-Chirp3-HD-${voice}`, speakingRate, lines: timings }, null, 2) + '\n');
const data = Buffer.concat(parts);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
const out = outDir ? `${outDir}/narration.wav` : `${repo}/docs/video/samples/google_${voice}_v4.wav`;
writeFileSync(out, Buffer.concat([h, data]));
console.log(`google_${voice}_v4.wav ${(data.length / 2 / rate).toFixed(1)}s`);
