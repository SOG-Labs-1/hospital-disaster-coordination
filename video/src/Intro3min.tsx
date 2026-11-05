// 3分版（ハッカソンの紹介映像）。原稿は docs/video/3min-script.md、ナレーションは public/narration-3min.json（npm run narration:3min）。
// 場面の切れ目はナレーションの行の始まりから決める。画面の録画は public/captures/（video/capture/record.ts。git 管理外）。
import type { CSSProperties, ReactNode } from 'react';
import { Audio, Video } from '@remotion/media';
import { AbsoluteFill, Sequence, getStaticFiles, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import narration from '../public/narration-3min.json';
import { Background, clamp, ease, SceneFade, Subtitles } from './common';
import { Disasters } from './scenes/Disasters';
import { FlowMap, HospitalPictogram, TriageRoute } from './scenes/HospitalPictogram';
import { FloorPlan } from './scenes/FloorPlan';
import { Schedule } from './scenes/Schedule';
import { TwoFunctions } from './scenes/TwoFunctions';
import { c, fontFamily, TimingContext } from './theme';

const lines = narration.lines;
export const DELAY3 = 0.3;
const L = (n: number) => lines[n]!.start + DELAY3;
const E = (n: number) => lines[n]!.end + DELAY3;
// ハッカソンの規定（3分以内）に合わせて 2分59秒9（5397コマ）。最後の行のあとは題名を見せる
export const TOTAL3 = 179.9; // 「3分以内」に確実に収める

// 通しの場面（g1〜g4）の目印（録画の秒）。video/public/captures/manifest.json の g1 の note から写す
const G = { register: 6.8, request: 14.5, accept: 18.6, assign: 24.4, order: 28.4, depart: 29.7, arrive: 36.3, end: 39.0 };

const has = (file: string) => getStaticFiles().some((f) => f.name === `captures/${file}`);

/** 30秒版の場面を、3分版の行に読み替えて使う（map：30秒版の行番号 → 3分版の行番号） */
const Remap = ({ map, children }: { map: Record<number, number>; children: ReactNode }) => (
  <TimingContext.Provider value={{ at: (n) => L(map[n] ?? n), endAt: (n) => E(map[n] ?? n) }}>{children}</TimingContext.Provider>
);

// ---------------- 部品 ----------------

/** 画面の録画を枠に入れて見せる。clip の from〜to 秒を、場面の長さ dur 秒に合わせて再生する（速さは 0.6〜2.5 倍に収める） */
const Clip = ({ file, from, to, dur, label, style }: { file: string; from: number; to: number; dur: number; label?: string; style?: CSSProperties }) => {
  const { fps } = useVideoConfig();
  const rate = Math.min(2.5, Math.max(0.6, (to - from) / dur));
  return (
    <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      {label && <div style={{ fontFamily, fontSize: 28, fontWeight: 700, color: c.text, letterSpacing: 2 }}>{label}</div>}
      <div style={{ position: 'relative', aspectRatio: '16 / 9', border: `2px solid ${c.line}`, backgroundColor: c.bg2, overflow: 'hidden', boxShadow: `0 0 60px ${c.accentSoft}` }}>
        {has(file) ? (
          <Video src={staticFile(`captures/${file}`)} muted trimBefore={Math.round(from * fps)} playbackRate={rate} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        ) : (
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', color: c.sub, fontFamily, fontSize: 28 }}>録画 {file} がありません</AbsoluteFill>
        )}
      </div>
    </div>
  );
};

/** 用語の一言の説明（右上） */
const Term = ({ word, children }: { word: string; children: ReactNode }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [8, 20], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ position: 'absolute', right: 64, top: 150, maxWidth: 620, fontFamily, opacity: p, translate: `${(1 - p) * 30}px 0px`, backgroundColor: 'rgba(7,13,24,0.92)', border: `2px solid ${c.warn}`, padding: '12px 20px' }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: c.warn }}>{word}</div>
      <div style={{ fontSize: 24, color: c.text, marginTop: 4, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
};

/** 画面の文字（左上の札） */
const Tag = ({ children, color = c.accent, dashed, style }: { children: ReactNode; color?: string; dashed?: boolean; style?: CSSProperties }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [4, 16], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ position: 'absolute', left: 64, top: 96, fontFamily, fontSize: 30, fontWeight: 700, color, border: `3px ${dashed ? 'dashed' : 'solid'} ${color}`, padding: '4px 18px', backgroundColor: 'rgba(7,13,24,0.85)', opacity: p, ...style }}>
      {children}
    </div>
  );
};

/** 大きな文字だけの場面 */
const Big = ({ children, sub, size = 120 }: { children: ReactNode; sub?: ReactNode; size?: number }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, 18], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily, paddingBottom: 140 }}>
      <div style={{ fontSize: size, fontWeight: 700, color: c.text, letterSpacing: 12, opacity: p, filter: `blur(${(1 - p) * 10}px)`, textAlign: 'center' }}>{children}</div>
      {sub && <div style={{ marginTop: 26, fontSize: 32, color: c.sub, letterSpacing: 4, opacity: p, textAlign: 'center', lineHeight: 1.6 }}>{sub}</div>}
    </AbsoluteFill>
  );
};

/** 箇条書きを順に出す */
const Points = ({ items, style }: { items: ReactNode[]; style?: CSSProperties }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ position: 'absolute', fontFamily, display: 'flex', flexDirection: 'column', gap: 22, ...style }}>
      {items.map((it, i) => {
        const p = interpolate(frame, [i * 0.45 * fps + 6, i * 0.45 * fps + 18], [0, 1], { ...clamp, easing: ease });
        return (
          <div key={i} style={{ fontSize: 34, color: c.text, opacity: p, translate: `${(1 - p) * -24}px 0px`, display: 'flex', gap: 14, alignItems: 'baseline' }}>
            <span style={{ color: c.accent }}>■</span>
            <span>{it}</span>
          </div>
        );
      })}
    </div>
  );
};

// 録画の配置（字幕の帯 y≧900 にかからない大きさ）
// 字幕の帯（下から約260px）にかからないよう、録画は y≦800 に収める
const ONE: CSSProperties = { left: 385, top: 150, width: 1150 };
// 録画の上に添える札の位置（録画の左上の外）
const CAP: CSSProperties = { left: 385, top: 90 };
const TWO_L: CSSProperties = { left: 80, top: 250, width: 860 };
const TWO_R: CSSProperties = { left: 980, top: 250, width: 860 };
const THREE = (i: number): CSSProperties => ({ left: 60 + i * 610, top: 300, width: 580 });

// ---------------- 場面 ----------------

/** 「情報の伝達」：BCP の説明のあと、大きな文字で課題を出す */
const Problem = () => <Big sub="Communication">情報の伝達</Big>;

/** モードの区切り：場面の頭に大きく出して、すぐ消える（災害運用＝実線の青、訓練＝破線のだいだい） */
const ModeChapter = ({ mode }: { mode: 'live' | 'training' }) => {
  const frame = useCurrentFrame();
  const live = mode === 'live';
  const col = live ? c.accent : c.warn;
  const op = interpolate(frame, [0, 8, 40, 52], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ backgroundColor: `rgba(7,13,24,${0.92 * op})`, alignItems: 'center', justifyContent: 'center', fontFamily, paddingBottom: 140 }}>
      <div style={{ opacity: op, textAlign: 'center', scale: String(0.96 + 0.04 * op) }}>
        <div style={{ display: 'inline-block', fontSize: 92, fontWeight: 700, color: col, border: `5px ${live ? 'solid' : 'dashed'} ${col}`, padding: '10px 48px', letterSpacing: 8 }}>{live ? '■ 災害運用モード' : '◇ 訓練モード'}</div>
        <div style={{ marginTop: 26, fontSize: 34, color: c.text, letterSpacing: 4 }}>{live ? '災害のときに使う。AI は使わない' : 'ふだんの訓練。部署の役を Claude が担う'}</div>
      </div>
    </AbsoluteFill>
  );
};

/** いまどちらのモードかを右上に出し続ける札 */
const ModeBadge = ({ mode }: { mode: 'live' | 'training' }) => {
  const frame = useCurrentFrame();
  const live = mode === 'live';
  const col = live ? c.accent : c.warn;
  return (
    <div style={{ position: 'absolute', right: 64, top: 90, fontFamily, fontSize: 26, fontWeight: 700, color: col, border: `3px ${live ? 'solid' : 'dashed'} ${col}`, padding: '4px 16px', backgroundColor: 'rgba(7,13,24,0.85)', opacity: interpolate(frame, [40, 52], [0, 1], clamp) }}>
      {live ? '■ 災害運用モード' : '◇ 訓練モード'}
    </div>
  );
};

/** 部署どうしの情報がつながらない：本部と部署を結ぶ線が途切れ、患者・人・物に「？」 */
const BrokenLinks = () => {
  const frame = useCurrentFrame();
  const depts = [
    { n: '救急外来', x: 420, y: 250 },
    { n: '手術室', x: 1500, y: 250 },
    { n: '病棟', x: 420, y: 630 },
    { n: '外来ホール', x: 1500, y: 630 },
  ];
  const cx = 960, cy = 440;
  return (
    <AbsoluteFill>
      <svg width={1920} height={1080}>
        {depts.map((d, i) => {
          const p = interpolate(frame, [4 + i * 5, 16 + i * 5], [0, 1], { ...clamp, easing: ease });
          const br = interpolate(frame, [30 + i * 6, 40 + i * 6], [0, 1], clamp);
          const mx = (cx + d.x) / 2, my = (cy + d.y) / 2;
          return (
            <g key={d.n} opacity={p}>
              <line x1={cx} y1={cy} x2={mx - (mx - cx) * 0.12 * br} y2={my - (my - cy) * 0.12 * br} stroke={c.line} strokeWidth={3} />
              <line x1={mx + (d.x - mx) * 0.12 * br} y1={my + (d.y - my) * 0.12 * br} x2={d.x} y2={d.y} stroke={c.line} strokeWidth={3} />
              <text x={mx} y={my + 14} fill={c.red} fontFamily={fontFamily} fontSize={44} fontWeight={700} textAnchor="middle" opacity={br}>✕</text>
              <rect x={d.x - 150} y={d.y - 50} width={300} height={100} fill="rgba(7,13,24,0.9)" stroke={c.line} strokeWidth={2} />
              <text x={d.x} y={d.y + 10} fill={c.text} fontFamily={fontFamily} fontSize={30} fontWeight={700} textAnchor="middle">{d.n}</text>
            </g>
          );
        })}
        <rect x={cx - 140} y={cy - 55} width={280} height={110} fill={c.bg2} stroke={c.accent} strokeWidth={3} />
        <text x={cx} y={cy + 10} fill={c.text} fontFamily={fontFamily} fontSize={34} fontWeight={700} textAnchor="middle">本部</text>
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 740, display: 'flex', justifyContent: 'center', gap: 70, fontFamily, fontSize: 36, color: c.text, opacity: interpolate(frame, [50, 62], [0, 1], clamp) }}>
        <span><span style={{ color: c.red }}>◆</span> 患者 ？</span>
        <span>○ 人 ？</span>
        <span><span style={{ color: c.accent }}>▭</span> 物 ？</span>
        <span style={{ color: c.sub }}>── どこに、どれだけ？</span>
      </div>
    </AbsoluteFill>
  );
};

/** 出典つきの数字（画面の上に出す） */
const Fact = ({ children, source }: { children: ReactNode; source: string }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [10, 24], [0, 1], { ...clamp, easing: ease });
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, top: 90, fontFamily, opacity: p, translate: `0px ${(1 - p) * -16}px`, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <div style={{ fontSize: 32, fontWeight: 700, color: c.text, backgroundColor: 'rgba(7,13,24,0.9)', borderLeft: `6px solid ${c.warn}`, padding: '8px 18px' }}>{children}</div>
      <div style={{ fontSize: 20, color: c.sub, paddingLeft: 24 }}>出典：{source}</div>
    </div>
  );
};

/** 同僚の評価 */
const Quote = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [4, 20], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily, paddingBottom: 160 }}>
      <div style={{ opacity: p, maxWidth: 1400, textAlign: 'center' }}>
        <div style={{ fontSize: 28, color: c.sub, letterSpacing: 4 }}>操作した同僚の評価</div>
        <div style={{ marginTop: 24, fontSize: 50, fontWeight: 700, color: c.text, lineHeight: 1.5 }}>「この規模の訓練をシミュレーションできることは、<br />災害対策・BCPにおいても有用」</div>
      </div>
    </AbsoluteFill>
  );
};

/** Claude Code での作り方（数字は 2026-11-05 にリポジトリで確認：コミット60、TypeScript 約1.46万行、自動テスト 177＋画面テスト30＝207件） */
const BuiltWith = () => {
  const frame = useCurrentFrame();
  const stats = [
    ['コミット', '約60'],
    ['TypeScript', '約1.5万行'],
    ['自動テスト', '207件'],
  ];
  return (
    <AbsoluteFill style={{ fontFamily }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 110, textAlign: 'center', fontSize: 40, fontWeight: 700, color: c.text, opacity: interpolate(frame, [0, 12], [0, 1], clamp) }}>
        Claude Code での作り方
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 200, display: 'flex', justifyContent: 'center', gap: 60 }}>
        {stats.map(([k, v], i) => {
          const p = interpolate(frame, [8 + i * 6, 20 + i * 6], [0, 1], { ...clamp, easing: ease });
          return (
            <div key={k} style={{ opacity: p, width: 360, border: `3px solid ${c.accent}`, padding: '20px 0', textAlign: 'center', backgroundColor: 'rgba(7,13,24,0.8)' }}>
              <div style={{ fontSize: 26, color: c.sub }}>{k}</div>
              <div style={{ fontSize: 60, fontWeight: 700, color: c.text, marginTop: 6 }}>{v}</div>
            </div>
          );
        })}
      </div>
      <Points
        items={[
          '先に決まりを書く（CLAUDE.md）：架空データのみ／AIは提案だけ／医療判断をしない',
          '点検用サブエージェント：決まりの違反（invariant-auditor）・使いやすさ（ux-reviewer）',
          '設定の自動検証フック ／ ソフトと映像を別のセッションで並行して開発',
        ]}
        style={{ left: 200, right: 200, top: 440, gap: 24 }}
      />
    </AbsoluteFill>
  );
};

/** 一人でも、他の部署を相手に：本部を中心に、Claude が演じる部署が並ぶ */
const SoloDrill = () => {
  const frame = useCurrentFrame();
  const roles = ['救急外来', '手術室', '3階東病棟', '外来ホール'];
  const cx = 960, cy = 440;
  return (
    <AbsoluteFill>
      <svg width={1920} height={1080}>
        {roles.map((r, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / roles.length + Math.PI / 4;
          const x = cx + Math.cos(a) * 470, y = cy + Math.sin(a) * 250;
          const p = interpolate(frame, [6 + i * 7, 18 + i * 7], [0, 1], { ...clamp, easing: ease });
          const wave = (frame / 30 + i * 0.3) % 1;
          return (
            <g key={r} opacity={p}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke={c.warn} strokeWidth={2} strokeDasharray="10 10" />
              <circle cx={cx + (x - cx) * wave} cy={cy + (y - cy) * wave} r={7} fill={c.warn} />
              <rect x={x - 150} y={y - 50} width={300} height={100} fill="rgba(7,13,24,0.9)" stroke={c.warn} strokeWidth={3} strokeDasharray="12 8" />
              <text x={x} y={y - 6} fill={c.text} fontFamily={fontFamily} fontSize={30} fontWeight={700} textAnchor="middle">{r}</text>
              <text x={x} y={y + 30} fill={c.warn} fontFamily={fontFamily} fontSize={22} textAnchor="middle">役：Claude</text>
            </g>
          );
        })}
        <rect x={cx - 150} y={cy - 60} width={300} height={120} fill={c.bg2} stroke={c.accent} strokeWidth={4} />
        <text x={cx} y={cy - 8} fill={c.text} fontFamily={fontFamily} fontSize={34} fontWeight={700} textAnchor="middle">本部</text>
        <text x={cx} y={cy + 32} fill={c.accent} fontFamily={fontFamily} fontSize={24} textAnchor="middle">あなた（一人でも）</text>
      </svg>
    </AbsoluteFill>
  );
};

/** 提案 → プログラムが検証 → 反映 */
const Guard = () => {
  const frame = useCurrentFrame();
  const steps = [
    { t: 'Claude', s: '決められた形の「提案」だけ', col: c.warn, dashed: true },
    { t: 'プログラムが検証', s: '存在しない患者・受け入れ枠の超過などは反映しない', col: c.accent },
    { t: '反映', s: '訓練のシミュレーターへ', col: c.green },
  ];
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 120, right: 120, top: 230, display: 'flex', alignItems: 'center', gap: 28, fontFamily }}>
        {steps.map((st, i) => {
          const p = interpolate(frame, [6 + i * 14, 20 + i * 14], [0, 1], { ...clamp, easing: ease });
          return (
            <div key={st.t} style={{ display: 'contents' }}>
              {i > 0 && <div style={{ fontSize: 60, color: c.sub, opacity: p }}>→</div>}
              <div style={{ flex: 1, minHeight: 230, border: `4px ${st.dashed ? 'dashed' : 'solid'} ${st.col}`, padding: '24px 26px', opacity: p, translate: `0px ${(1 - p) * 30}px`, backgroundColor: 'rgba(7,13,24,0.8)' }}>
                <div style={{ fontSize: 44, fontWeight: 700, color: st.col }}>{st.t}</div>
                <div style={{ fontSize: 28, color: c.text, marginTop: 14, lineHeight: 1.5 }}>{st.s}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 560, textAlign: 'center', fontFamily, fontSize: 26, color: c.sub, opacity: interpolate(frame, [50, 64], [0, 1], clamp) }}>
        strict tool use（JSON Schema で出力の形を固定）／ 部署ごとに、その部署が知り得る情報だけを渡す
      </div>
    </AbsoluteFill>
  );
};

/** 災害運用モードは AI を使わない */
const NoAi = () => (
  <AbsoluteFill style={{ fontFamily }}>
    <div style={{ position: 'absolute', left: 260, right: 260, top: 200, display: 'flex', gap: 60 }}>
      <div style={{ flex: 1, border: `4px solid ${c.accent}`, padding: '30px 34px', backgroundColor: 'rgba(7,13,24,0.8)' }}>
        <div style={{ fontSize: 44, fontWeight: 700, color: c.accent }}>■ 災害運用モード</div>
        <div style={{ fontSize: 34, color: c.text, marginTop: 20, lineHeight: 1.6 }}>AI を使わない<br />Claude が止まっても、記録と共有は動く</div>
      </div>
      <div style={{ flex: 1, border: `4px dashed ${c.warn}`, padding: '30px 34px', backgroundColor: 'rgba(7,13,24,0.8)' }}>
        <div style={{ fontSize: 44, fontWeight: 700, color: c.warn }}>◇ 訓練モード</div>
        <div style={{ fontSize: 34, color: c.text, marginTop: 20, lineHeight: 1.6 }}>部署役：Claude API<br />医療の判断はしない</div>
      </div>
    </div>
  </AbsoluteFill>
);

/** 締め */
const Final = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, 22], [0, 1], { ...clamp, easing: ease });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily, paddingBottom: 120 }}>
      <div style={{ fontSize: 150, fontWeight: 700, color: c.text, letterSpacing: 24, opacity: p, filter: `blur(${(1 - p) * 10}px)` }}>タシカメ</div>
      <div style={{ marginTop: 22, width: interpolate(p, [0, 1], [0, 560]), height: 3, backgroundColor: c.accent }} />
      <div style={{ marginTop: 26, fontSize: 32, color: c.sub, letterSpacing: 6, opacity: p }}>院内災害対応の調整ツール ／ AI訓練モード</div>
      <div style={{ marginTop: 44, fontSize: 24, color: c.sub, letterSpacing: 1, opacity: p, textAlign: 'center', lineHeight: 1.7 }}>
        Claude Code で開発 ／ Claude Code Hackathon 2026
        <br />
        github.com/SOG-Labs-1/hospital-disaster-coordination
        <br />
        データはすべて架空です ／ All data is fictional ／ 音声：Google Cloud Text-to-Speech ／ 効果音：自作
      </div>
    </AbsoluteFill>
  );
};

// ---------------- 並び ----------------

type Shot = { from: number; to: number; name: string; node: (dur: number, start: number) => ReactNode; fade?: number };

// 場面の切り替えは、話し始めの少し前（前の文が終わってから。最大 0.8 秒前）。画面が変わってから間をおいて話し出す
const cut = (n: number) => (n === 0 ? 0 : L(n) - Math.min(0.8, L(n) - E(n - 1) - 0.08));

/** 搬送中の小さな地図：場面の長さに合わせて患者が救急外来から手術室へ動く */
const MovingMap = ({ dur }: { dur: number }) => {
  const frame = useCurrentFrame();
  return <FlowMap step="move" progress={interpolate(frame, [15, dur * 30 * 0.8], [0, 1], clamp)} />;
};

// 実写あり版の冒頭：Pexels の素材（docs/video/stock-sources.md。public/stock/、git 管理外）を暗く青い色調にそろえてつなぐ
const STOCK_END = 9.2;
const STOCK: { file: string; from: number; to: number; at: number; until: number; portrait?: boolean; bright?: number }[] = [
  { file: 'storm-clouds.mp4', from: 0.5, to: 2.7, at: 0, until: 2.2 },
  { file: 'lightning-night.mp4', from: 5.9, to: 8.9, at: 2.2, until: 4.8, bright: 1.1 },
  { file: 'rain-pavement.mp4', from: 10, to: 12, at: 4.8, until: 6.6 },
  { file: 'hospital-corridor.mp4', from: 0.8, to: 3.4, at: 6.6, until: STOCK_END, portrait: true },
];

const StockShot = ({ file, from, to, dur, portrait, bright = 0.62 }: { file: string; from: number; to: number; dur: number; portrait?: boolean; bright?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = 1.04 + (frame / (dur * fps)) * 0.06;
  const fade = interpolate(frame, [0, 8, dur * fps - 8, dur * fps], [0, 1, 1, 0], clamp);
  const has = getStaticFiles().some((f) => f.name === `stock/${file}`);
  return (
    <AbsoluteFill style={{ opacity: fade, overflow: 'hidden', backgroundColor: c.bg }}>
      {has && (
        <Video
          src={staticFile(`stock/${file}`)}
          muted
          trimBefore={Math.round(from * fps)}
          playbackRate={Math.min(2, Math.max(0.5, (to - from) / dur))}
          style={portrait
            // 縦長の素材は横幅いっぱいに広げ、中央より少し上を見せる（object-fit が効かないため大きさを直接決める）
            ? { position: 'absolute', left: 0, width: 1920, height: (1920 * 16) / 9, top: -1180, scale: String(zoom), filter: `brightness(${bright}) contrast(1.12) saturate(0.45)` }
            : { position: 'absolute', inset: 0, width: '100%', height: '100%', scale: String(zoom), filter: `brightness(${bright}) contrast(1.12) saturate(0.45)` }}
        />
      )}
      {/* 青く暗い色調と周辺の減光、細い格子（ほかの場面となじませる） */}
      <AbsoluteFill style={{ background: 'linear-gradient(rgba(8,24,60,0.38), rgba(4,10,24,0.5))', mixBlendMode: 'multiply' }} />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 45%, transparent 40%, rgba(0,0,0,0.7) 100%)' }} />
      <AbsoluteFill style={{ backgroundImage: `linear-gradient(${c.grid} 1px, transparent 1px), linear-gradient(90deg, ${c.grid} 1px, transparent 1px)`, backgroundSize: '64px 64px' }} />
    </AbsoluteFill>
  );
};

const buildShots = (stock: boolean): Shot[] => [
  // 1. 冒頭
  ...(stock
    ? [
        { from: 0, to: STOCK_END, name: '冒頭：実写', node: () => (
          <>
            {STOCK.map((k) => (
              <Sequence key={k.file} from={Math.round(k.at * 30)} durationInFrames={Math.round((k.until - k.at) * 30) + 8}>
                <StockShot file={k.file} from={k.from} to={k.to} dur={k.until - k.at + 0.27} portrait={k.portrait} bright={k.bright} />
              </Sequence>
            ))}
          </>
        ) } as Shot,
        // 実写のあとは、病院の輪郭に患者が流れ込む図から（地図はすぐに消える）
        { from: STOCK_END, to: cut(2), name: '冒頭：病院に患者が', node: (_d, s) => (
          <TimingContext.Provider value={{ at: (n) => (n === 0 ? -10 : s + 0.1), endAt: (n) => (n === 0 ? -9 : s + 3) }}><Disasters start={s} /></TimingContext.Provider>
        ) } as Shot,
      ]
    : [
        { from: 0, to: cut(2), name: '冒頭：災害の多い日本', node: (_d, s) => (
          <>
            <Remap map={{ 0: 0, 1: 1 }}><Disasters start={s} /></Remap>
          </>
        ) } as Shot,
      ]),
  { from: cut(2), to: cut(4), name: '情報の伝達', node: () => (
    <Sequence from={Math.round((L(3) - cut(2)) * 30)}><Problem /></Sequence>
  ) },
  // 2. 経緯
  { from: cut(4), to: cut(7), name: '経緯：見取り図', node: (_d, s) => (
    <>
      <Remap map={{ 2: 6, 3: 6 }}><FloorPlan start={s} /></Remap>
      <Tag>制作者：災害対応に深く関わる病院の看護師</Tag>
      <Tag style={{ top: 150, fontSize: 24, fontWeight: 400, borderWidth: 0, color: c.sub }}>見取り図は架空です</Tag>
    </>
  ) },
  { from: cut(7), to: cut(8), name: '部署どうしの情報がつながらない', node: () => (
    <>
      <BrokenLinks />
      <Fact source="千代ほか、日本臨床救急医学会雑誌 15巻3号（2012）">訓練の参加者アンケートでも「連携と情報伝達が不十分」の回答が多い（154人）</Fact>
    </>
  ) },
  { from: cut(8), to: cut(9), name: '訓練の時間がない', node: (_d, s) => (
    <>
      <Remap map={{ 4: 8 }}><Schedule start={s} /></Remap>
      <Fact source="日本看護管理学会「病院における防災訓練に関する実態調査報告書」（2024、300病院）">訓練の日も、87.3%の病院は通常どおり業務</Fact>
    </>
  ) },
  // 3. 2つのモード
  { from: cut(9), to: cut(11), name: '2つのモード', node: (_d, s) => <Remap map={{ 5: 9, 6: 10 }}><TwoFunctions start={s} heading="― 2つのモード ―" liveLabel="災害運用モード" trainingLabel="訓練モード" /></Remap> },
  // 4. 災害運用モード：ひとつの場面
  { from: cut(11), to: cut(12), name: '病院の様子とトリアージ', node: () => (
    <>
      <HospitalPictogram phase="terminals" />
      <Tag>例：ある地震の日（架空の病院）／ 場所ごとのパソコンで開く・ログイン不要</Tag>
      <Sequence from={20}><TriageRoute /></Sequence>
    </>
  ) },
  { from: cut(12), to: cut(14), name: '救急外来で登録→本部に出る', node: (d) => (
    <>
      <FlowMap step="register" />
      <Clip file="g1-flow-er.webm" from={0.5} to={G.register + 3} dur={d} label="救急外来の端末" style={TWO_L} />
      <Clip file="g2-flow-hq.webm" from={0.5} to={G.register + 3} dur={d} label="本部（災害対策本部）の端末" style={TWO_R} />
    </>
  ) },
  { from: cut(14), to: cut(15), name: '依頼→了承→指示', node: (d) => (
    <>
      <FlowMap step="request" />
      <Clip file="g2-flow-hq.webm" from={G.register + 3} to={G.depart} dur={d} label="本部の端末" style={TWO_L} />
      <Clip file="g3-flow-or.webm" from={G.register + 3} to={G.depart} dur={d} label="手術室の端末" style={TWO_R} />
      <Term word="搬送要員">患者を運ぶ担当の職員</Term>
    </>
  ) },
  { from: cut(15), to: cut(16), name: '出発・到着が3台に同時に', node: (d) => (
    <>
      <MovingMap dur={d} />
      <Clip file="g2-flow-hq.webm" from={G.depart - 1} to={G.end} dur={d} label="本部" style={THREE(0)} />
      <Clip file="g3-flow-or.webm" from={G.depart - 1} to={G.end} dur={d} label="手術室" style={THREE(1)} />
      <Clip file="g4-flow-board.webm" from={G.depart - 1} to={G.end} dur={d} label="本部の大型モニター" style={THREE(2)} />
    </>
  ) },
  { from: cut(16), to: cut(17), name: '依頼したこと／起きたこと', node: (d) => <Clip file="c-transport.webm" from={0} to={9} dur={d} style={ONE} /> },
  { from: cut(17), to: cut(18), name: '未確認・重複の警告・使いやすさ', node: (d) => (
    <>
      <Tag>大きな文字とボタン ／ 色＋記号＋文字（◆赤 ▲黄 ●緑）／ 白黒で読める印刷</Tag>
      <Clip file="d-hospital-status.webm" from={4} to={10.5} dur={d} label="報告のない場所は「未確認」（ゼロと区別）" style={TWO_L} />
      <Clip file="h-duplicate-warning.webm" from={5} to={13} dur={d} label="同じタッグ番号は警告。理由を残して先へ" style={TWO_R} />
    </>
  ) },
  // 5. 訓練モード
  { from: cut(18), to: cut(19), name: '訓練：部署役の報告', node: (d) => (
    <>
      <Clip file="i1-training-report.webm" from={0} to={8.8} dur={d} style={ONE} />
      <Tag color={c.warn} dashed style={CAP}>部署役：Claude API（claude-sonnet-5-5）</Tag>
    </>
  ) },
  { from: cut(19), to: cut(20), name: '一人でも', node: () => (
    <>
      <SoloDrill />
      <Tag color={c.warn} dashed>一人でも、他の部署を相手に本部の訓練ができる</Tag>
    </>
  ) },
  { from: cut(20), to: cut(21), name: '振り返り', node: (d) => (
    <>
      <Clip file="i3-training-review.webm" from={1} to={15} dur={d} style={ONE} />
      <Tag color={c.warn} dashed style={CAP}>照合と根拠の番号：プログラム ／ 説明文：Claude</Tag>
    </>
  ) },
  { from: cut(21), to: cut(22), name: '同僚の評価', node: () => <Quote /> },
  // 6. 安全のしくみ
  { from: cut(22), to: cut(23), name: '提案→検証→反映', node: () => <Guard /> },
  { from: cut(23), to: cut(24), name: '医療の判断はしない', node: (d) => (
    <>
      <Clip file="i2-training-refusal.webm" from={15} to={23} dur={d} style={ONE} />
      <Tag color={c.warn} dashed style={CAP}>Claude API の実際の返事</Tag>
    </>
  ) },
  { from: cut(24), to: cut(25), name: 'AIを使わない', node: () => <NoAi /> },
  // 7. どの病院でも
  { from: cut(25), to: cut(26), name: 'どの病院でも', node: (d) => (
    <>
      <Clip file="j-hospitals.webm" from={0} to={15.6} dur={d} style={ONE} />
      <Tag color={c.text} style={CAP}>病院ごとの設定で導入（総合病院・中規模病院の2つの架空の病院）</Tag>
    </>
  ) },
  // 8. Claude Code での作り方
  { from: cut(26), to: cut(27), name: 'Claude Code での作り方', node: () => <BuiltWith /> },
  // 8. 締め
  { from: cut(27), to: TOTAL3, name: '締め', node: () => <Final />, fade: 1 },
];

const SHOTS = { plain: buildShots(false), stock: buildShots(true) };

// 話題の切れ目になる行（ここで場面をいったん暗くする）
const SECTION_STARTS = [2, 4, 9, 11, 18, 22, 25, 26, 27];
const XF = 10; // クロスフェードのコマ数

export const Intro3min = ({ stock = false }: { stock?: boolean }) => {
  const { fps } = useVideoConfig();
  const shots = stock ? SHOTS.stock : SHOTS.plain;
  return (
    <AbsoluteFill style={{ fontFamily }}>
      <Background />
      {shots.map((s, i) => {
        // 同じ話題の中の切り替え（次の場面が話題の切れ目でない）は、暗くせずに重ねて切り替える（クロスフェード）。
        // 話題の切れ目（SECTION_STARTS）だけ、いったん暗くしてから次へ
        const next = shots[i + 1];
        const crossToNext = !!next && !SECTION_STARTS.some((n) => Math.abs(next.from - cut(n)) < 0.01);
        const crossFromPrev = i > 0 && !SECTION_STARTS.some((n) => Math.abs(s.from - cut(n)) < 0.01);
        const from = Math.round(s.from * fps);
        const durationInFrames = Math.round(s.to * fps) - from + (crossToNext ? XF : 0);
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames} name={s.name}>
            <SceneFade durationInFrames={durationInFrames} fadeIn={i === 0 ? 1 : crossFromPrev ? XF : 8} fadeOut={crossToNext ? XF : (s.fade ?? 8)}>
              {s.node(s.to - s.from, s.from)}
            </SceneFade>
          </Sequence>
        );
      })}
      {/* 災害運用モードと訓練モードの区切り：場面の頭に大きく、そのあとは右上の札で示し続ける */}
      <Sequence from={Math.round(cut(11) * fps)} durationInFrames={Math.round((cut(18) - cut(11)) * fps)} name="災害運用モードの区切り">
        <ModeChapter mode="live" />
        <ModeBadge mode="live" />
      </Sequence>
      <Sequence from={Math.round(cut(18) * fps)} durationInFrames={Math.round((cut(22) - cut(18)) * fps)} name="訓練モードの区切り">
        <ModeChapter mode="training" />
        <ModeBadge mode="training" />
      </Sequence>
      {/* BCP の説明は、BCP と言ったところから「情報の伝達」の前まで長めに出す */}
      <Sequence from={Math.round((L(1) + 0.8) * fps)} durationInFrames={Math.round((L(3) - L(1) - 0.8) * fps)} name="BCPの説明">
        <Term word="BCP（事業継続計画）">災害のときも、病院の機能を続けるための計画</Term>
      </Sequence>
      <Subtitles lines={lines} delay={DELAY3} variant="cinema" />
      {/* 低音の効果音（自作。scripts/sfx.mjs）：場面ごとに違う音。ナレーションより大きくならないよう音量を測って決めた（2026-11-05） */}
      {([
        ['sfx/boom-tail.wav', L(3) - 0.05, 0.35, '効果音：情報の伝達'],
        ['sfx/reveal.wav', L(9) - 1.5, 0.22, '効果音：タシカメ'],
        ['sfx/radio.wav', cut(18) + 0.1, 0.25, '効果音：訓練モード'],
        ['sfx/outro.wav', cut(27) + 0.1, 0.3, '効果音：締め'],
      ] as const).map(([src, t, volume, name]) => (
        <Sequence key={name} from={Math.round(t * fps)} name={name}>
          <Audio src={staticFile(src)} volume={volume} />
        </Sequence>
      ))}
      <Sequence from={0} durationInFrames={Math.round(4.5 * fps)} name="地鳴り">
        <Audio src={staticFile('sfx/rumble.wav')} volume={0.6} />
      </Sequence>
      <Sequence from={Math.round(DELAY3 * fps)} name="ナレーション">
        <Audio src={staticFile('narration-3min.wav')} volume={0.85} />
      </Sequence>
    </AbsoluteFill>
  );
};
