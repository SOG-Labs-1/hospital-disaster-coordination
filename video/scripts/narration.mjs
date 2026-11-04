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
const gemini = process.env.GEMINI_TTS;
const stylePrompt = process.env.STYLE_PROMPT ?? '深く、落ち着いた、信頼感のある穏やかな声で。ドキュメンタリーのナレーションのように、ゆっくり、はっきりと読んでください。';
const tag = gemini ? `gemini_${voice}` : `google_${voice}`;

// [読み上げる文, 英語の字幕, 後ろの無音（秒）]。字幕の日本語は読み上げ用の「エーアイ」を「AI」に戻して使う
// 第2版の原稿（です・ます）。声は Enceladus（利用者が聞き比べて選んだ）
const lines = [
  ['地震、豪雨、台風。', 'Earthquakes. Torrential rain. Typhoons.', 0.5],
  ['災害のたび、病院には患者が押し寄せます。', 'With every disaster, patients pour into hospitals.', 0.8],
  ['患者は、人は、物は、いまどこにあるのか。', 'Patients, staff, supplies: where are they right now?', 0.45],
  ['混乱の中で、院内の状況はつかみきれません。', 'In the chaos, no one has the full picture.', 0.8],
  ['日々の業務に追われ、訓練も十分にはできません。', 'Busy with daily work, staff rarely get to train.', 1.0],
  ['タシカメは、二つの機能で備えます。', 'Tashikame prepares hospitals in two ways.', 0.5],
  ['災害時の院内調整ツールと、エーアイを相手にした、平常時の訓練です。', 'A coordination tool for disasters, and everyday drills with AI.', 0.8],
  ['総合病院から、中規模病院まで。', 'From general hospitals to mid-sized hospitals.', 0.4],
  ['安全で効率的な災害対応を、支えます。', 'Supporting safe, efficient disaster response.', 0.6],
];

async function synth(text) {
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({
      // GEMINI_TTS=モデル名 のときは Gemini-TTS（話し方を文章で指示できる）。指示は STYLE_PROMPT
      input: gemini ? { text, prompt: stylePrompt } : { text },
      voice: gemini ? { languageCode: 'ja-JP', name: voice, modelName: gemini } : { languageCode: 'ja-JP', name: `ja-JP-Chirp3-HD-${voice}` },
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
for (const [t, en, pause] of lines) {
  const v = trim(Buffer.from(pcm(await synth(t))));
  timings.push({ text: t.replace('エーアイ', 'AI'), en, start: +(pos / 2 / rate).toFixed(3), end: +((pos + v.length) / 2 / rate).toFixed(3) });
  parts.push(v); pos += v.length;
  const silence = Buffer.alloc(Math.round(pause * rate) * 2);
  parts.push(silence); pos += silence.length;
}
const outDir = process.env.OUT_DIR;
if (outDir) writeFileSync(`${outDir}/narration.json`, JSON.stringify({ voice: gemini ? `${gemini}/${voice}` : `ja-JP-Chirp3-HD-${voice}`, speakingRate, lines: timings }, null, 2) + '\n');
const data = Buffer.concat(parts);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
const out = outDir ? `${outDir}/narration.wav` : `${repo}/docs/video/samples/${tag}_v5.wav`;
writeFileSync(out, Buffer.concat([h, data]));
console.log(`${tag}_v5.wav ${(data.length / 2 / rate).toFixed(1)}s`);
