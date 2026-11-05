import type { ReactNode } from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { AUDIO_DELAY, c, fontFamily, lines as lines30 } from './theme';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const ease = Easing.bezier(0.16, 1, 0.3, 1);

/** 背景：濃い紺に細い格子と周辺の減光 */
export const Background = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${c.grid} 1px, transparent 1px), linear-gradient(90deg, ${c.grid} 1px, transparent 1px)`,
          backgroundSize: '64px 64px',
          backgroundPosition: `${-frame * 0.4}px ${-frame * 0.2}px`,
        }}
      />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 45%, rgba(30,60,110,0.35) 0%, transparent 55%, rgba(0,0,0,0.65) 100%)' }} />
    </AbsoluteFill>
  );
};

/** 場面の出入りを短いフェードと少しのぼかしでつなぐ */
export const SceneFade = ({ children, durationInFrames, fadeIn = 10, fadeOut = 10 }: { children: ReactNode; durationInFrames: number; fadeIn?: number; fadeOut?: number }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        opacity: interpolate(frame, [0, fadeIn, durationInFrames - fadeOut, durationInFrames], [0, 1, 1, 0], clamp),
        filter: `blur(${interpolate(frame, [0, fadeIn, durationInFrames - fadeOut, durationInFrames], [8, 0, 0, 8], clamp)}px)`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/** 画面の上の帯：ツール名と、進んでいく確認時刻 */
export const Hud = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const base = 10 * 3600 + 42 * 60 + 5;
  const t = base + Math.floor((frame / fps) * 7);
  const hh = String(Math.floor(t / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return (
    <AbsoluteFill style={{ fontFamily, color: c.sub, fontSize: 22, letterSpacing: 2, padding: '40px 64px', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', opacity: interpolate(frame, [0, 20], [0, 1], clamp) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.accent, opacity: 0.5 + 0.5 * Math.abs(Math.sin(frame / 12)) }} />
        TASHIKAME ／ DEMO
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums' }}>
        確認時刻 {hh}:{mm}:{ss}
      </div>
    </AbsoluteFill>
  );
};

/** ナレーションと同じ字幕（画面に焼き込む） */
type SubLine = { text: string; en?: string; start: number; end: number };

/** 長い字幕を2行に分ける。真ん中に近い句読点の後ろで改行する（「。」を少し優先）。短すぎる行ができるときは分けない */
export function breakLine(text: string, max: number, marks: string[], minPart: number): string {
  if (text.length <= max) return text;
  const mid = text.length / 2;
  let best = -1;
  let bestScore = Infinity;
  marks.forEach((mark, rank) => {
    for (let i = text.indexOf(mark); i >= 0; i = text.indexOf(mark, i + 1)) {
      const at = i + mark.length;
      if (at < minPart || text.length - at < minPart) continue;
      const score = Math.abs(at - mid) + rank * 3;
      if (score < bestScore) [best, bestScore] = [at, score];
    }
  });
  return best < 0 ? text : `${text.slice(0, best).trimEnd()}\n${text.slice(best).trimStart()}`;
}

/** 映画風の字幕の改行：日本語と英語のどちらかが1行に収まらないときだけ、両方を2行にする（片方だけ改行しない）。
 *  幅は文字数からの見積もり（日本語 36px＋字間5px、英数字はその約半分。英語 27px の細字＋字間1.6px）。余裕をみて 1560px を超えたら2行に。
 *  区切りは文の終わり（「。」、英語の ". "）を強く優先し、日本語と英語が同じ意味の所で分かれるようにする。自動の折り返しはさせない（white-space: pre） */
export function cinemaLines(ja: string, en: string): [string, string] {
  // 原稿で「｜」を入れた所は、その位置で日本語・英語とも改行する
  if (ja.includes('｜') || en.includes('｜')) return [ja.replace('｜', '\n').replaceAll('｜', ''), en.replace('｜', '\n').replaceAll('｜', '')];
  const MAX = 1560; // 実際の幅は見積もりより広がることがあるので余裕をもつ
  const jaWidth = [...ja].reduce((w, ch) => w + (/[\x20-\x7e]/.test(ch) ? 23 : 41), 0);
  const enWidth = en.length * 15.2;
  if (jaWidth <= MAX && enWidth <= MAX) return [ja, en];
  return [splitAt(ja, ['。', '、'], 6), splitAt(en, ['. ', '? ', ': ', ', ', ' '], 12)];
}

/** 真ん中に近い区切りで2つに分ける。前の区切りほど優先（例：「。」を「、」より） */
function splitAt(text: string, marks: string[], minPart: number): string {
  const mid = text.length / 2;
  let best = -1;
  let bestScore = Infinity;
  marks.forEach((mark, rank) => {
    for (let i = text.indexOf(mark); i >= 0; i = text.indexOf(mark, i + 1)) {
      const at = i + mark.length;
      if (at < minPart || text.length - at < minPart) continue;
      const score = Math.abs(at - mid) / text.length + rank * 0.25;
      if (score < bestScore) [best, bestScore] = [at, score];
    }
  });
  return best < 0 ? text : `${text.slice(0, best).trimEnd()}\n${text.slice(best).trimStart()}`;
}

/** cinema：背景の箱なし。細い文字を字間を空けて置き、影で読みやすくする（映画の字幕のような雰囲気。3分版） */
const SHADOW = '0 0 10px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)';
export const Subtitles = ({ lines = lines30 as SubLine[], delay = AUDIO_DELAY, variant = 'box' }: { lines?: SubLine[]; delay?: number; variant?: 'box' | 'cinema' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const at = (n: number) => lines[n]!.start + delay;
  const endAt = (n: number) => lines[n]!.end + delay;
  const i = lines.findIndex((_, n) => t >= at(n) - 0.08 && t < endAt(n) + 0.4);
  if (i < 0) return null;
  const local = t - (at(i) - 0.08);
  const left = endAt(i) + 0.4 - t;
  if (variant === 'cinema') {
    const op = Math.min(interpolate(local, [0, 0.25], [0, 1], clamp), interpolate(left, [0, 0.25], [0, 1], clamp));
    const [ja, en] = cinemaLines(lines[i]!.text, lines[i]!.en ?? '');
    return (
      <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 52 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, opacity: op }}>
          <div style={{ fontFamily, fontSize: 36, fontWeight: 400, color: '#f3f6fa', letterSpacing: 5, textAlign: 'center', lineHeight: 1.55, whiteSpace: 'pre', textShadow: SHADOW }}>
            {ja}
          </div>
          {en && (
            <div style={{ fontFamily: `'Helvetica Neue', 'Avenir Next', Arial, sans-serif`, fontWeight: 300, fontSize: 27, color: '#e8eef5', letterSpacing: 1.6, textAlign: 'center', lineHeight: 1.4, whiteSpace: 'pre', textShadow: SHADOW }}>
              {en}
            </div>
          )}
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 44 }}>
      <div
        style={{
          fontFamily,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          padding: '14px 34px 16px',
          backgroundColor: 'rgba(4, 8, 16, 0.74)',
          borderLeft: `4px solid ${c.accent}`,
          opacity: Math.min(interpolate(local, [0, 0.15], [0, 1], clamp), interpolate(left, [0, 0.15], [0, 1], clamp)),
          translate: `0px ${interpolate(local, [0, 0.3], [12, 0], { ...clamp, easing: ease })}px`,
        }}
      >
        <div style={{ fontSize: 42, fontWeight: 700, color: c.text, letterSpacing: 2, maxWidth: 1760, textAlign: 'center', lineHeight: 1.35, whiteSpace: 'pre-line' }}>{breakLine(lines[i]!.text.replaceAll('｜', ''), 30, ['。', '、'], 6)}</div>
        {lines[i]!.en && <div style={{ fontFamily: `'Helvetica Neue', Arial, sans-serif`, fontSize: 30, color: '#c9d6e8', letterSpacing: 0.5, textAlign: 'center', whiteSpace: 'pre-line' }}>{breakLine(lines[i]!.en, 78, ['. ', '? ', ', '], 20)}</div>}
      </div>
    </AbsoluteFill>
  );
};

/** 場面の中の見出し（字幕とは別に、要点を大きく出す） */
export const Kicker = ({ children, from, style }: { children: ReactNode; from: number; style?: React.CSSProperties }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = frame - from * fps;
  return (
    <div
      style={{
        fontFamily,
        color: c.text,
        opacity: interpolate(f, [0, 12], [0, 1], clamp),
        translate: `0px ${interpolate(f, [0, 18], [24, 0], { ...clamp, easing: ease })}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export { clamp };
