import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from 'remotion';
import { clamp, Kicker } from '../common';
import { c, fontFamily, useTiming } from '../theme';

const days = ['月', '火', '水', '木', '金', '土', '日'];
const rows = 5;
const duties = ['日勤', '夜勤', '外来', '手術', '病棟', '会議', '当直'];
const TRAINING = { r: 2, d: 4 };

/** 場面3：日々の業務に追われ、訓練もままならない。 */
export const Schedule = ({ start, caption = true }: { start: number; caption?: boolean }) => {
  const { at } = useTiming();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + start;
  const s = at(4) - 0.2;
  const W = 150;
  const H = 74;
  const x0 = (1920 - W * 7) / 2;
  const y0 = 230;

  return (
    <AbsoluteFill style={{ fontFamily }}>
      <svg width={1920} height={1080}>
        {days.map((d, i) => (
          <text key={d} x={x0 + i * W + W / 2} y={y0 - 20} fill={c.sub} fontSize={26} textAnchor="middle" fontFamily={fontFamily}>
            {d}
          </text>
        ))}
        {Array.from({ length: rows }, (_, r) =>
          days.map((_, d) => {
            const isTraining = r === TRAINING.r && d === TRAINING.d;
            const fillAt = s + 0.15 + (r * 7 + d) * 0.035 + random(`f${r}${d}`) * 0.2;
            const p = interpolate(t, [fillAt, fillAt + 0.18], [0, 1], clamp);
            const x = x0 + d * W;
            const y = y0 + r * H;
            if (isTraining) {
              const pulse = 0.55 + 0.45 * Math.abs(Math.sin((t - s) * 3));
              return (
                <g key={`${r}-${d}`}>
                  <rect x={x + 4} y={y + 4} width={W - 8} height={H - 8} fill="none" stroke={c.warn} strokeWidth={3} strokeDasharray="10 8" opacity={pulse} />
                  <text x={x + W / 2} y={y + H / 2 + 9} fill={c.warn} fontSize={26} fontWeight={700} textAnchor="middle" fontFamily={fontFamily} opacity={pulse}>
                    訓練
                  </text>
                </g>
              );
            }
            const duty = duties[Math.floor(random(`u${r}${d}`) * duties.length)]!;
            return (
              <g key={`${r}-${d}`}>
                <rect x={x + 4} y={y + 4} width={W - 8} height={H - 8} fill={`rgba(88,196,255,${0.04 + p * 0.16})`} stroke={c.line} strokeWidth={1.5} />
                <text x={x + W / 2} y={y + H / 2 + 9} fill={c.text} fontSize={24} textAnchor="middle" fontFamily={fontFamily} opacity={p}>
                  {duty}
                </text>
              </g>
            );
          }),
        )}
      </svg>
      {caption && <AbsoluteFill style={{ top: 680, alignItems: 'center' }}>
        <Kicker from={at(4) + 0.9 - start} style={{ fontSize: 30, color: c.sub, letterSpacing: 3 }}>
          看護師として、院内BCP訓練で見た課題から。
        </Kicker>
      </AbsoluteFill>}
    </AbsoluteFill>
  );
};
