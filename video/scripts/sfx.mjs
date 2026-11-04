// 3分版の低音の効果音を自作する（外部の素材なし。権利の心配がない）
// 使い方: node scripts/sfx.mjs   → public/sfx/impact.wav（重い「ドン」）、public/sfx/swell.wav（低くふくらむ音。場面の変わり目に）
import { mkdirSync, writeFileSync } from 'node:fs';

const rate = 48000;
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const lowpass = (fc) => {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
  let y = 0;
  return (x) => (y += a * (x - y));
};

function write(file, seconds, gen) {
  const n = Math.round(seconds * rate);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = gen(i / rate, i);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const gain = 0.708 / peak; // -3dBFS
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, buf[i] * gain)) * 32767);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  mkdirSync('public/sfx', { recursive: true });
  writeFileSync(file, Buffer.concat([h, data]));
  console.log(`${file} ${seconds}s`);
}

// 重い「ドン」：70Hz から 32Hz へ下がる低い音と、こもった打撃音。2.4秒かけて消える
{
  let phase = 0;
  const lp = lowpass(180);
  write('public/sfx/impact.wav', 2.4, (t) => {
    const f = 32 + 38 * Math.exp(-t / 0.25);
    phase += (2 * Math.PI * f) / rate;
    const body = Math.sin(phase) * Math.exp(-t / 0.9);
    const hit = lp(rnd()) * 6 * Math.exp(-t / 0.06);
    const fadeIn = Math.min(1, t / 0.004);
    const fadeOut = Math.min(1, (2.4 - t) / 0.2);
    return (body + hit) * fadeIn * fadeOut;
  });
}

// 低くふくらむ音：1.6秒かけて大きくなり、最後に止まる（次の場面の頭に「ドン」を重ねる想定）
{
  let phase = 0;
  let brown = 0;
  const lp1 = lowpass(120);
  const lp2 = lowpass(160);
  write('public/sfx/swell.wav', 1.8, (t) => {
    const f = 40 + 25 * (t / 1.8);
    phase += (2 * Math.PI * f) / rate;
    brown = (brown + rnd() * 0.02) * 0.998;
    const noise = lp2(lp1(brown)) * 8;
    const env = Math.pow(Math.min(1, t / 1.6), 2.2) * Math.min(1, (1.8 - t) / 0.12);
    return (Math.sin(phase) * 0.5 + noise) * env;
  });
}
