// 地鳴り（「ゴゴゴ」）の効果音を自作する。外部の素材を使わないので権利の心配がない
// 使い方: node scripts/rumble.mjs [秒数=4.5] [出力=public/sfx/rumble.wav]
// 中身：低域だけを残したブラウンノイズ＋ゆっくり揺れる 30〜50Hz の低い音＋ときどきの「ドン」という鈍い響き
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , secArg, outArg] = process.argv;
const seconds = Number(secArg ?? 4.5);
const out = outArg ?? 'public/sfx/rumble.wav';
const rate = 48000;
const n = Math.round(seconds * rate);

// 乱数は種つき（毎回同じ音になる）
let seed = 20261105;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

// 1次の低域通過フィルタ
const lowpass = (fc) => {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
  let y = 0;
  return (x) => (y += a * (x - y));
};
const highpass = (fc) => {
  const lp = lowpass(fc);
  return (x) => x - lp(x);
};

// 音量の山：0.6秒で立ち上がり、1.6〜2.6秒が最も強く、そのあとゆっくり消える
const envelope = (t) => {
  const rise = Math.min(1, t / 1.6) ** 1.6;
  const fall = t < 2.6 ? 1 : Math.exp(-(t - 2.6) / 0.75);
  const tail = Math.min(1, (seconds - t) / 0.15); // 最後の切れ目を滑らかに
  return rise * fall * Math.max(0, tail);
};

// 「ドン」の時刻（秒）と強さ
const thuds = [
  [0.9, 0.5],
  [1.75, 0.8],
  [2.3, 0.65],
  [3.0, 0.4],
];

const L = new Float32Array(n);
const R = new Float32Array(n);
for (const [ch, buf] of [
  [0, L],
  [1, R],
]) {
  seed = 20261105 + ch * 7919;
  let brown = 0;
  const lp1 = lowpass(90);
  const lp2 = lowpass(140);
  const hp = highpass(22);
  const crackleLp = lowpass(900);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    brown = (brown + rnd() * 0.02) * 0.998;
    let noise = lp2(lp1(brown)) * 9;
    // 揺れ：数Hzでうねるように強弱をつける
    const wobble = 0.65 + 0.35 * Math.sin(2 * Math.PI * 3.1 * t + ch) * Math.sin(2 * Math.PI * 0.7 * t);
    noise *= wobble;
    // 低い音：周波数をゆっくり揺らす
    const f = 38 + 6 * Math.sin(2 * Math.PI * 0.45 * t) + 3 * Math.sin(2 * Math.PI * 1.3 * t + 1);
    phase += (2 * Math.PI * f) / rate;
    const sub = Math.sin(phase) * 0.28 * wobble;
    // ドン：短い減衰の低い音
    let thud = 0;
    for (const [at, g] of thuds) {
      const d = t - at;
      if (d >= 0 && d < 0.6) thud += g * Math.sin(2 * Math.PI * (52 - 30 * d) * d) * Math.exp(-d / 0.16);
    }
    // ざらつき：建物がきしむような細かい音を、ごく小さく
    const crackle = crackleLp(Math.abs(rnd()) > 0.997 ? rnd() * 0.6 : 0) * 0.5;
    buf[i] = hp((noise + sub + thud * 0.55 + crackle) * envelope(t));
  }
}

// 最大値を -3dBFS にそろえる
let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const gain = 0.708 / peak;

const data = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * gain)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * gain)) * 32767), i * 4 + 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([h, data]));
console.log(`${out} ${seconds}s`);
