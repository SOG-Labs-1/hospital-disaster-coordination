// 3分版の効果音と BGM を自作する（外部の素材なし。権利の心配がない）
// 使い方: node scripts/sfx.mjs
//   public/sfx/boom-tail.wav  「情報の伝達」：重いドンと、長く残る低い響き
//   public/sfx/reveal.wav     タシカメの名前：低い音がふくらみ、明るい和音に開く
//   public/sfx/radio.wav      訓練モードへ：無線の「ザッ」と、低く脈打つ音
//   public/sfx/outro.wav      締め：長く伸びる低い余韻
//   public/sfx/bgm.wav        BGM の試作（約3分）。利用者の判断で映像には使っていない。git には入れない
import { mkdirSync, writeFileSync } from 'node:fs';

const rate = 48000;
let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const lowpass = (fc) => {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
  let y = 0;
  return (x) => (y += a * (x - y));
};
const highpass = (fc) => {
  const lp = lowpass(fc);
  return (x) => x - lp(x);
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** gen(t) は [左, 右] を返す。peakDb でいちばん大きい所の音量をそろえる */
function write(file, seconds, gen, peakDb = -3) {
  const n = Math.round(seconds * rate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) [L[i], R[i]] = gen(i / rate);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const gain = 10 ** (peakDb / 20) / peak;
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
  mkdirSync('public/sfx', { recursive: true });
  writeFileSync(file, Buffer.concat([h, data]));
  console.log(`${file} ${seconds}s`);
}

/** 簡単な残響（くし形フィルタを4本） */
function reverb(decay = 0.82) {
  const lens = [1557, 1617, 1491, 1422].map((x) => Math.round((x * rate) / 44100));
  const bufs = lens.map((l) => new Float32Array(l));
  const idx = lens.map(() => 0);
  const lps = lens.map(() => lowpass(2500));
  return (x) => {
    let y = 0;
    bufs.forEach((b, k) => {
      const out = b[idx[k]];
      b[idx[k]] = x + lps[k](out) * decay;
      idx[k] = (idx[k] + 1) % b.length;
      y += out;
    });
    return y / 4;
  };
}

const note = (midi) => 440 * 2 ** ((midi - 69) / 12);

// 「情報の伝達」：重いドン＋長い残響（4秒）
{
  let ph = 0;
  const lp = lowpass(160);
  const revL = reverb(0.86), revR = reverb(0.84);
  write('public/sfx/boom-tail.wav', 4.5, (t) => {
    const f = 30 + 45 * Math.exp(-t / 0.2);
    ph += (2 * Math.PI * f) / rate;
    const dry = (Math.sin(ph) * Math.exp(-t / 0.7) + lp(rnd()) * 5 * Math.exp(-t / 0.05)) * Math.min(1, t / 0.003);
    const fade = clamp01((4.5 - t) / 0.4);
    return [(dry + revL(dry) * 1.6) * fade, (dry + revR(dry) * 1.6) * fade];
  });
}

// タシカメの名前：1.5秒ふくらむ低い音 → 明るい和音（Cメジャー）が開いて消える（4秒）
{
  const chord = [36, 48, 52, 55, 60, 64].map(note);
  const ph = chord.map(() => 0);
  let sub = 0;
  const lp = lowpass(1400);
  const revL = reverb(0.8), revR = reverb(0.78);
  write('public/sfx/reveal.wav', 4.5, (t) => {
    const rise = Math.pow(clamp01(t / 1.5), 2);
    sub += (2 * Math.PI * (40 + 25 * clamp01(t / 1.5))) / rate;
    const swell = Math.sin(sub) * rise * (t < 1.5 ? 1 : Math.exp(-(t - 1.5) / 0.4));
    let pad = 0;
    chord.forEach((f, k) => {
      ph[k] += (2 * Math.PI * f) / rate;
      pad += Math.sin(ph[k]) * (k < 2 ? 0.5 : 0.25);
    });
    const open = t < 1.5 ? 0 : Math.min(1, (t - 1.5) / 0.08) * Math.exp(-(t - 1.5) / 1.3);
    const dry = swell * 0.8 + lp(pad) * open * 0.7;
    const fade = clamp01((4.5 - t) / 0.3);
    return [(dry + revL(dry)) * fade, (dry + revR(dry)) * fade];
  });
}

// 訓練モードへ：無線の「ザッ」（帯域を絞った雑音）＋低く脈打つ音 3回（2.6秒）
{
  const hp = highpass(400), lp = lowpass(2600);
  let ph = 0;
  write('public/sfx/radio.wav', 2.6, (t) => {
    const squelch = t < 0.22 ? lp(hp(rnd())) * 1.2 * Math.min(1, t / 0.01) * clamp01((0.22 - t) / 0.03) : 0;
    ph += (2 * Math.PI * 52) / rate;
    let pulse = 0;
    for (const at of [0.3, 0.9, 1.5]) {
      const d = t - at;
      if (d >= 0 && d < 0.9) pulse += Math.sin(ph) * Math.exp(-d / 0.18) * Math.min(1, d / 0.01);
    }
    const v = squelch * 0.5 + pulse;
    return [v, v];
  });
}

// 締め：長く伸びる低い余韻（Aマイナーの低い和音がゆっくり消える、5秒）
{
  const chord = [33, 45, 52, 57].map(note);
  const ph = chord.map(() => 0);
  const lp = lowpass(700);
  const revL = reverb(0.85), revR = reverb(0.83);
  write('public/sfx/outro.wav', 5, (t) => {
    let v = 0;
    chord.forEach((f, k) => {
      ph[k] += (2 * Math.PI * f) / rate;
      v += Math.sin(ph[k]) * (k === 0 ? 0.7 : 0.35);
    });
    const env = Math.min(1, t / 0.6) * Math.exp(-t / 1.8);
    const dry = lp(v) * env;
    return [dry + revL(dry), dry + revR(dry)];
  });
}

// BGM：低く静かなシンセの持続音。和音は Am → F → C → G を 8 秒ずつ、ゆっくり重ねて変える（約3分）
{
  const seconds = 182;
  const prog = [
    [45, 52, 57, 60],
    [41, 48, 53, 57],
    [36, 48, 52, 55],
    [43, 50, 55, 59],
  ].map((c) => c.map(note));
  const bar = 8;
  const phases = new Map();
  const lpL = lowpass(650), lpR = lowpass(620);
  let subPh = 0;
  let lfo = 0;
  write('public/sfx/bgm.wav', seconds, (t) => {
    const i = Math.floor(t / bar);
    const k = (t % bar) / bar;
    const cur = prog[i % 4], nxt = prog[(i + 1) % 4];
    // 小節の終わり 1.5 秒で次の和音へなめらかに移る
    const x = clamp01((k * bar - (bar - 1.5)) / 1.5);
    let l = 0, r = 0;
    for (let v = 0; v < 4; v++) {
      for (const [w, f] of [[1 - x, cur[v]], [x, nxt[v]]]) {
        if (w <= 0) continue;
        // 左右で少しずらした2本ののこぎり波（温かい音）。位相は音の高さごとに持つ（和音が変わってもぷつっと鳴らない）
        const p1 = (phases.get(f) ?? 0) + f / rate;
        const p2 = (phases.get(-f) ?? 0) + (f * 1.003) / rate;
        phases.set(f, p1 % 1);
        phases.set(-f, p2 % 1);
        const saw = (p1 % 1) * 2 - 1;
        const saw2 = (p2 % 1) * 2 - 1;
        l += w * saw * 0.18;
        r += w * saw2 * 0.18;
      }
    }
    subPh += (2 * Math.PI * (cur[0] / 2)) / rate;
    lfo += (2 * Math.PI * 0.07) / rate;
    const sub = Math.sin(subPh) * 0.35;
    const breathe = 0.8 + 0.2 * Math.sin(lfo);
    const fade = Math.min(1, t / 6) * clamp01((seconds - t) / 4);
    return [(lpL(l) * breathe + sub) * fade, (lpR(r) * breathe + sub) * fade];
  }, -6);
}
