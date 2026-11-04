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
export const Subtitles = ({ lines = lines30 as SubLine[], delay = AUDIO_DELAY }: { lines?: SubLine[]; delay?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const at = (n: number) => lines[n]!.start + delay;
  const endAt = (n: number) => lines[n]!.end + delay;
  const i = lines.findIndex((_, n) => t >= at(n) - 0.08 && t < endAt(n) + 0.4);
  if (i < 0) return null;
  const local = t - (at(i) - 0.08);
  const left = endAt(i) + 0.4 - t;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 56 }}>
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
        <div style={{ fontSize: lines[i]!.text.length > 34 ? 38 : 44, fontWeight: 700, color: c.text, letterSpacing: 2, maxWidth: 1600, textAlign: 'center', lineHeight: 1.35 }}>{lines[i]!.text}</div>
        {lines[i]!.en && <div style={{ fontFamily: `'Helvetica Neue', Arial, sans-serif`, fontSize: 30, color: '#c9d6e8', letterSpacing: 0.5 }}>{lines[i]!.en}</div>}
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
