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
// VERTEX_TTS=モデル名（例 gemini-3.1-flash-tts-preview）：Vertex AI の generateContent で Gemini の声を作る。キーは .env の GEMINI_API_KEY（表示しない）。
// 話し方は VERTEX_PROMPT（指示）。速さの数値は使えないので、指示の言葉で決める
const vertex = process.env.VERTEX_TTS;
// 試聴（「ゆっくりめに」）では長すぎたため、利用者の判断で少し速めの指示にした（2026-11-05）
// 2026-11-05 利用者の指摘「もう少しテンポよく」で、ニュース・ドキュメンタリー調の指示に（試聴 docs/video/samples/gemini-tempo/Charon.wav）
const vertexPrompt = process.env.VERTEX_PROMPT ?? '日本の医療ドキュメンタリーのナレーターとして、次の文を読んでください。深く、落ち着いた、信頼感のある穏やかな男性の声で。テレビのニュースやドキュメンタリーのナレーションのように、テンポよく、はきはきと。間は短めに保ち、語尾までしっかり言い切ってください。感情を込めすぎず、聞き手に静かに語りかけるように。';
const stylePrompt = process.env.STYLE_PROMPT ?? '深く、落ち着いた、信頼感のある穏やかな声で。ドキュメンタリーのナレーションのように、ゆっくり、はっきりと読んでください。';
const tag = vertex ? `vertex_${voice}` : gemini ? `gemini_${voice}` : `google_${voice}`;

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
  const key = createHash('sha256').update(JSON.stringify(vertex ? ['vertex', vertex, text, voice, vertexPrompt] : [text, voice, speakingRate, gemini ?? '', gemini ? stylePrompt : ''])).digest('hex').slice(0, 24);
  const file = `${cacheDir}${key}.wav`;
  if (existsSync(file)) return readFileSync(file);
  const wav = vertex ? await synthVertex(text) : await synthApi(text);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, wav);
  return wav;
}
/** Vertex AI の Gemini の声。返る音声（24kHz・16bit・モノラルの生の PCM）を 48kHz にして WAV にする */
async function synthVertex(text) {
  const vkey = process.env.GEMINI_API_KEY;
  if (!vkey) { console.error('GEMINI_API_KEY が .env にありません'); process.exit(1); }
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://aiplatform.googleapis.com/v1/projects/926016263642/locations/global/publishers/google/models/${vertex}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': vkey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${vertexPrompt}\n\n${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { languageCode: 'ja-JP', voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 300);
      if (attempt < 4 && (r.status === 429 || r.status >= 500)) { await new Promise((ok) => setTimeout(ok, 3000 * attempt)); continue; }
      console.error(`失敗 ${r.status}: ${msg}`); process.exit(1);
    }
    const j = await r.json();
    const part = j.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
    if (!part) { if (attempt < 4) continue; console.error(`音声が返らない: ${JSON.stringify(j).slice(0, 200)}`); process.exit(1); }
    const src = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000);
    const raw = Buffer.from(part.inlineData.data, 'base64');
    // 直線補間で 48kHz に
    const n = raw.length / 2, m = Math.round((n * rate) / src);
    const out = Buffer.alloc(m * 2);
    for (let i = 0; i < m; i++) {
      const x = (i * src) / rate, k = Math.floor(x), f = x - k;
      const a0 = raw.readInt16LE(Math.min(n - 1, k) * 2), a1 = raw.readInt16LE(Math.min(n - 1, k + 1) * 2);
      out.writeInt16LE(Math.round(a0 + (a1 - a0) * f), i * 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + out.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(out.length, 40);
    return Buffer.concat([h, out]);
  }
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
const READ = [['BCP', 'ビーシーピー'], ['Claude Code', 'クロードコード'], ['Claude', 'クロード'], ['AI', 'エーアイ'], ['ID', 'アイディー'], ['「0人」', 'ゼロにん'], ['年に何度も', 'ねんに何度も'], ['私は', 'わたしは'], ['私が', 'わたしが']];
const gapAfter = new Map();
const spoken = (t) => READ.reduce((x, [a, b]) => x.replaceAll(a, b), t.replaceAll('｜', '')); // 「｜」は字幕の改行の位置（読まない）
let script = lines.map(([t, en, pause]) => ({ say: t, text: t.replace('エーアイ', 'AI'), en, pause, section: 0 }));
if (process.env.SCRIPT_MD) {
  const md = readFileSync(process.env.SCRIPT_MD, 'utf8');
  const body = md.slice(0, md.indexOf('## 推せるポイント'));
  script = [];
  let section = -1;
  // 次の段落に移る前の無音の長さ（「（間：N秒）」の行で決める）
  for (const line of body.split('\n')) {
    if (/^## \d/.test(line)) { section = Math.floor(section) + 1; continue; }
    if (section < 0 || !line.startsWith('| ') || line.startsWith('| 読み上げ') || line.startsWith('|---')) continue;
    const [ja, en] = line.split('|').slice(1, 3).map((x) => x.trim());
    // 「（間：N秒）」の行：読み上げない。その長さの無音を入れて、段落をそこで区切る（画面の文字だけで見せる所）
    const gap = ja.match(/^（間：([\d.]+)秒）$/);
    if (gap) { section += 0.01; gapAfter.set(script.at(-1).section, Number(gap[1])); continue; }
    // 間（秒）：話す内容（場面）が変わるところは長めに。PAUSE_LINE・PAUSE_SECTION で調整する
    if (script.length && script.at(-1).section !== section) script.at(-1).pause = Number(process.env.PAUSE_SECTION ?? 1.5);
    script.push({ say: spoken(ja), text: ja, en, pause: Number(process.env.PAUSE_LINE ?? 0.6), section });
  }
  script.at(-1).pause = 0.5;
}
// PARAGRAPH=1：場面（section）ごとに文をまとめて1回で読ませる（文と文のつながりの抑揚が自然になる。利用者が聞き比べて選んだ）。
// 文ごとの始まりと終わり（字幕の時刻）は、音声の無音の区間から割り出す
if (process.env.PARAGRAPH === '1') {
  const sections = [...new Set(script.map((x) => x.section))];
  for (const sec of sections) {
    const items = script.filter((x) => x.section === sec);
    let v = trim(Buffer.from(pcm(await synth(items.map((x) => x.say).join('')))));
    let n = v.length / 2;
    const amp = (i) => Math.abs(v.readInt16LE(i * 2));
    // 無音の区間（振幅が小さい状態が 120ms 以上続く所）を探す
    const quiet = [];
    const win = Math.round(0.01 * rate);
    let startQ = -1;
    for (let i = 0; i < n; i += win) {
      let m = 0;
      for (let k = i; k < Math.min(n, i + win); k++) m = Math.max(m, amp(k));
      if (m < 600) { if (startQ < 0) startQ = i; }
      else if (startQ >= 0) { if (i - startQ >= 0.12 * rate) quiet.push([startQ, i]); startQ = -1; }
    }
    // 文の切れ目の見込み：それぞれの文を1文だけで読ませた長さの割合（同じ声・速さ。保存してあるので2回目からは API を呼ばない）
    const single = [];
    for (const x of items) single.push(trim(Buffer.from(pcm(await synth(x.say)))).length / 2);
    const total = single.reduce((t, d) => t + d, 0);
    // 文の終わり（「。」）をまとめて決める：見込みの位置と無音の区間を、順番を保ったまま最もよく合うように組み合わせる（動的計画法）
    const ratio = n / total;
    const sents = []; // { line, expect }：「。」ごとの文と、その終わりの見込み位置
    let acc = 0;
    items.forEach((x, k) => {
      const parts = x.say.split(/(?<=。)/).filter(Boolean);
      for (const sp of parts) {
        acc += single[k] * (sp.length / x.say.length) * ratio;
        sents.push({ line: k, expect: acc });
      }
    });
    const ends = sents.slice(0, -1); // 最後の文の終わりは区間の最後
    // 各文の長さの見込み（1文で読んだ長さを段落全体の長さに合わせて縮めたもの）
    const durs = sents.map((st, j) => st.expect - (j ? sents[j - 1].expect : 0));
    const w = Number(process.env.SPLIT_W ?? 0.5);
    const mid = (q) => (quiet[q][0] + quiet[q][1]) / 2;
    const len = (q) => quiet[q][1] - quiet[q][0];
    // 動的計画法：文 j の終わりを無音 q にするとき、見込みは「前の文の終わり（無音 p の終わり）＋ 文 j の長さ」
    const Q = quiet.length;
    if (Q < ends.length) throw new Error(`場面 ${sec}：無音の区間が足りない`);
    const dp = ends.map(() => new Array(Q).fill(Infinity));
    const prev = ends.map(() => new Array(Q).fill(-1));
    const cost = (expect, q) => Math.abs(mid(q) - expect) / rate - w * (len(q) / rate);
    if (ends.length) for (let q = 0; q < Q; q++) dp[0][q] = cost(durs[0], q);
    for (let j = 1; j < ends.length; j++) {
      for (let q = 0; q < Q; q++) {
        for (let p = 0; p < q; p++) {
          if (dp[j - 1][p] === Infinity) continue;
          const c = dp[j - 1][p] + cost(quiet[p][1] + durs[j], q);
          if (c < dp[j][q]) [dp[j][q], prev[j][q]] = [c, p];
        }
      }
    }
    const chosen = new Array(ends.length);
    if (ends.length) {
      // 最後の文が、段落の終わり（n）にちょうど収まるかも見る
      const last = durs.at(-1);
      const total2 = dp.at(-1).map((v, q) => v + Math.abs(quiet[q][1] + last - n) / rate);
      let q = total2.indexOf(Math.min(...total2));
      for (let j = ends.length - 1; j >= 0; j--) { chosen[j] = quiet[q]; q = prev[j][q]; }
    }
    // 行の切れ目＝その行の最後の文の終わり
    const bounds = [];
    sents.forEach((st, j) => { if (j < ends.length && sents[j + 1].line !== st.line) bounds.push(chosen[j]); });
    if (process.env.SPLIT_DEBUG) console.error(`場面${sec} 見込み ${ends.map((e) => (e.expect / rate).toFixed(2)).join(' ')} 無音 ${quiet.map(([a, b]) => `${(a / rate).toFixed(2)}+${((b - a) / rate).toFixed(2)}`).join(' ')}`);
    if (process.env.SPLIT_DEBUG) console.error(`場面${sec}: ${bounds.map(([a, b]) => `${(a / rate).toFixed(2)}+${((b - a) / rate).toFixed(2)}`).join(' ')}`);
    // GAP_MAX（秒）：文と文の間の無音が長すぎるときは、その長さまで詰める（声そのものは速くしない。Gemini の声は文の間が長いため）
    const gapMax = process.env.GAP_MAX ? Math.round(Number(process.env.GAP_MAX) * rate) : 0;
    if (gapMax) {
      const pieces = [];
      let last = 0;
      const shifted = [];
      let removed = 0;
      for (const [a, b] of bounds) {
        const len = b - a;
        if (len > gapMax) {
          const keepA = Math.floor(gapMax / 2), keepB = gapMax - keepA;
          pieces.push(v.subarray(last * 2, (a + keepA) * 2));
          last = b - keepB;
          shifted.push([a - removed, a - removed + gapMax]);
          removed += len - gapMax;
        } else shifted.push([a - removed, b - removed]);
      }
      pieces.push(v.subarray(last * 2));
      v = Buffer.concat(pieces);
      n = v.length / 2;
      bounds.splice(0, bounds.length, ...shifted);
    }
    const base = pos / 2;
    items.forEach((x, k) => {
      const s0 = k === 0 ? 0 : bounds[k - 1][1];
      const e0 = k === items.length - 1 ? n : bounds[k][0];
      timings.push({ text: x.text, en: x.en, section: sec, start: +((base + s0) / rate).toFixed(3), end: +((base + e0) / rate).toFixed(3) });
    });
    parts.push(v); pos += v.length;
    const pause = sec === sections.at(-1) ? 0.5 : (gapAfter.get(sec) ?? Number(process.env.PAUSE_SECTION ?? 1.5));
    const silence = Buffer.alloc(Math.round(pause * rate) * 2);
    parts.push(silence); pos += silence.length;
  }
  script.length = 0;
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
if (outDir) writeFileSync(`${outDir}/${outName}.json`, JSON.stringify({ voice: vertex ? `${vertex}/${voice}` : gemini ? `${gemini}/${voice}` : `ja-JP-Chirp3-HD-${voice}`, ...(vertex ? { prompt: vertexPrompt } : {}), speakingRate, lines: timings }, null, 2) + '\n');
const data = Buffer.concat(parts);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
const out = outDir ? `${outDir}/${outName}.wav` : `${repo}/docs/video/samples/${tag}_v5.wav`;
writeFileSync(out, Buffer.concat([h, data]));
console.log(`${tag}_v5.wav ${(data.length / 2 / rate).toFixed(1)}s`);
