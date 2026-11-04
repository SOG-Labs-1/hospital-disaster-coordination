import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { clamp, ease } from '../common';
import { at, c, fontFamily } from '../theme';

// 大きさの違う病院の輪郭（架空）。どれにも同じ画面が入る
const buildings = [
  { w: 420, h: 300, label: '総合病院' },
  { w: 300, h: 220, label: '中規模病院' },
  { w: 240, h: 170, label: '中規模病院' },
];

/** 場面5：総合病院から、中規模病院まで。安全で効率的な災害対応を、実現する。 */
export const Closing = ({ start }: { start: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + start;
  const final = interpolate(t, [at(8) - 0.3, at(8) + 0.5], [0, 1], { ...clamp, easing: ease });
  let x = (1920 - (420 + 300 + 240 + 2 * 90)) / 2;

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <AbsoluteFill style={{ opacity: 1 - final, translate: `0px ${-final * 60}px` }}>
        <svg width={1920} height={1080}>
          {buildings.map((b, i) => {
            const s = at(7) + i * 0.45;
            const p = interpolate(t, [s - 0.2, s + 0.4], [0, 1], { ...clamp, easing: ease });
            const bx = x;
            x += b.w + 90;
            const by = 700 - b.h;
            const glow = interpolate(t, [s + 0.4, s + 0.8], [0, 1], clamp);
            return (
              <g key={i} opacity={p} transform={`translate(0 ${(1 - p) * 40})`}>
                <rect x={bx} y={by} width={b.w} height={b.h} fill="none" stroke={c.text} strokeWidth={3} />
                {/* 同じ画面（タシカメ）が入る */}
                <rect x={bx + b.w * 0.3} y={by + b.h * 0.25} width={b.w * 0.4} height={b.h * 0.3} fill={c.accentSoft} stroke={c.accent} strokeWidth={2} opacity={glow} />
                <text x={bx + b.w / 2} y={760} fill={c.sub} fontFamily={fontFamily} fontSize={28} textAnchor="middle">
                  {b.label}
                </text>
              </g>
            );
          })}
        </svg>
      </AbsoluteFill>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: final }}>
        <div style={{ fontSize: 140, fontWeight: 700, color: c.text, letterSpacing: 24, filter: `blur(${(1 - final) * 10}px)` }}>タシカメ</div>
        <div style={{ marginTop: 22, width: interpolate(final, [0, 1], [0, 520]), height: 3, backgroundColor: c.accent }} />
        <div style={{ marginTop: 26, fontSize: 30, color: c.sub, letterSpacing: 6 }}>院内災害対応の調整ツール ／ AI訓練モード</div>
      </AbsoluteFill>
      {/* 字幕が2行になったので、クレジットは画面の下端ではなく題名の下に置く */}
      <AbsoluteFill style={{ top: 720, alignItems: 'center', gap: 8, opacity: final }}>
        <div style={{ fontSize: 22, color: c.sub, letterSpacing: 2 }}>Claude Code Hackathon 2026 ／ データはすべて架空です ／ All data is fictional</div>
        <div style={{ fontSize: 20, color: c.sub, letterSpacing: 2, opacity: 0.8 }}>音声：Google Cloud Text-to-Speech ／ 効果音：自作</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
