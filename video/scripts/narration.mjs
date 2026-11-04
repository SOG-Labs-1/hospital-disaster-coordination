// 使い方: OUT_DIR=video/public node video/scripts/narration.mjs <声の名前 例 Charon> [speakingRate]
// APIキーはリポジトリの .env の GOOGLE_TTS_API_KEY から読む（表示しない）
// 文ごとに音声を作り、決めた長さの無音をはさんで1本の WAV にする
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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

// 同じ文・声・速さの音声は video/.tts-cache/ に取っておき、作り直すときに API を呼ばない
const cacheDir = fileURLToPath(new URL('../.tts-cache/', import.meta.url));
async function synth(text) {
  const key = createHash('sha256').update(JSON.stringify([text, voice, speakingRate, gemini ?? '', gemini ? stylePrompt : ''])).digest('hex').slice(0, 24);
  const file = `${cacheDir}${key}.wav`;
  if (existsSync(file)) return readFileSync(file);
  const wav = await synthApi(text);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, wav);
  return wav;
}
async function synthApi(text) {
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
// SCRIPT_MD=原稿の md を渡すと、その表から読み上げを作る（3分版。原稿を1か所で直せば声と字幕が変わる）
// 表の1列目が読み上げ（字幕の日本語）、2列目が英語の字幕。「## 」の見出しごとに場面（section）を分け、場面の切れ目は長めの間にする
const READ = [['BCP', 'ビーシーピー'], ['Claude', 'クロード'], ['AI', 'エーアイ'], ['ID', 'アイディー'], ['「0人」', 'ゼロにん'], ['年に何度も', 'ねんに何度も']];
const spoken = (t) => READ.reduce((x, [a, b]) => x.replaceAll(a, b), t);
let script = lines.map(([t, en, pause]) => ({ say: t, text: t.replace('エーアイ', 'AI'), en, pause, section: 0 }));
if (process.env.SCRIPT_MD) {
  const md = readFileSync(process.env.SCRIPT_MD, 'utf8');
  const body = md.slice(0, md.indexOf('## 推せるポイント'));
  script = [];
  let section = -1;
  for (const line of body.split('\n')) {
    if (/^## \d/.test(line)) { section++; continue; }
    if (section < 0 || !line.startsWith('| ') || line.startsWith('| 読み上げ') || line.startsWith('|---')) continue;
    const [ja, en] = line.split('|').slice(1, 3).map((x) => x.trim());
    // 間（秒）：話す内容（場面）が変わるところは長めに。PAUSE_LINE・PAUSE_SECTION で調整する
    if (script.length && script.at(-1).section !== section) script.at(-1).pause = Number(process.env.PAUSE_SECTION ?? 1.5);
    script.push({ say: spoken(ja), text: ja, en, pause: Number(process.env.PAUSE_LINE ?? 0.6), section });
  }
  script.at(-1).pause = 0.5;
}
for (const { say: t, text, en, pause, section } of script) {
  const v = trim(Buffer.from(pcm(await synth(t))));
  timings.push({ text, en, section, start: +(pos / 2 / rate).toFixed(3), end: +((pos + v.length) / 2 / rate).toFixed(3) });
  parts.push(v); pos += v.length;
  const silence = Buffer.alloc(Math.round(pause * rate) * 2);
  parts.push(silence); pos += silence.length;
}
const outDir = process.env.OUT_DIR;
const outName = process.env.OUT_NAME ?? 'narration';
if (outDir) writeFileSync(`${outDir}/${outName}.json`, JSON.stringify({ voice: gemini ? `${gemini}/${voice}` : `ja-JP-Chirp3-HD-${voice}`, speakingRate, lines: timings }, null, 2) + '\n');
const data = Buffer.concat(parts);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
const out = outDir ? `${outDir}/${outName}.wav` : `${repo}/docs/video/samples/${tag}_v5.wav`;
writeFileSync(out, Buffer.concat([h, data]));
console.log(`${tag}_v5.wav ${(data.length / 2 / rate).toFixed(1)}s`);
