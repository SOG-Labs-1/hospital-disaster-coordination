import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from 'remotion';
import { clamp, ease, Kicker } from '../common';
import { at, c, fontFamily } from '../theme';

// 架空の院内の見取り図（実在の病院の配置ではない）
const rooms = [
  { name: '本部', x: 220, y: 200, w: 300, h: 200 },
  { name: '救急外来', x: 540, y: 200, w: 420, h: 200 },
  { name: '外来ホール', x: 980, y: 200, w: 520, h: 200 },
  { name: '講堂', x: 220, y: 420, w: 420, h: 300 },
  { name: '手術室', x: 660, y: 420, w: 300, h: 300 },
  { name: '病棟', x: 980, y: 420, w: 520, h: 300 },
];

type Kind = 'patient' | 'staff' | 'stretcher';
const items = Array.from({ length: 46 }, (_, i) => {
  const k = random(`k${i}`);
  const kind: Kind = k < 0.55 ? 'patient' : k < 0.85 ? 'staff' : 'stretcher';
  return { i, kind, x: 250 + random(`x${i}`) * 1220, y: 230 + random(`y${i}`) * 460, tri: Math.floor(random(`t${i}`) * 3) };
});

/** 場面2：患者は、人は、物は、どこにいるのか。院内の状況は、つかみきれない。 */
export const FloorPlan = ({ start }: { start: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + start;
  const s = at(2);
  // 「患者は」「人は」「物は」に合わせて種類ごとに強調する
  const focus = (kind: Kind) => {
    const k0 = { patient: s, staff: s + 1.05, stretcher: s + 1.95 }[kind];
    return interpolate(t, [k0, k0 + 0.25, k0 + 0.9, k0 + 1.2], [0, 1, 1, 0], clamp);
  };
  const chaos = interpolate(t, [at(3) - 0.2, at(3) + 1.6], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ translate: '100px -30px' }}>
      <svg width={1920} height={1080}>
        {rooms.map((r, i) => (
          <g key={r.name} opacity={interpolate(t, [start + i * 0.08, start + 0.4 + i * 0.08], [0, 1], clamp)}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(88,196,255,0.04)" stroke={c.line} strokeWidth={2} />
            <text x={r.x + 16} y={r.y + 34} fill={c.sub} fontFamily={fontFamily} fontSize={24}>
              {r.name}
            </text>
          </g>
        ))}
        {items.map((it) => {
          const appear = interpolate(t, [start + 0.2 + random(`a${it.i}`) * 0.8, start + 0.5 + random(`a${it.i}`) * 0.8], [0, 1], clamp);
          const jitter = chaos * 26;
          const x = it.x + Math.sin(t * (2 + random(`j${it.i}`) * 3) + it.i) * (6 + jitter);
          const y = it.y + Math.cos(t * (2 + random(`k${it.i}`) * 3) + it.i) * (4 + jitter);
          const f = focus(it.kind);
          const dim = 1 - 0.55 * Math.max(focus('patient'), focus('staff'), focus('stretcher')) * (1 - f);
          const op = appear * dim * (1 - chaos * 0.35 * random(`o${it.i}`));
          const scale = 1 + f * 0.45;
          if (it.kind === 'patient') {
            const col = [c.red, c.yellow, c.green][it.tri]!;
            const sym = ['◆', '▲', '●'][it.tri]!;
            return (
              <text key={it.i} x={x} y={y} fill={col} fontSize={26 * scale} textAnchor="middle" dominantBaseline="central" opacity={op}>
                {sym}
              </text>
            );
          }
          if (it.kind === 'staff') return <circle key={it.i} cx={x} cy={y} r={11 * scale} fill="none" stroke={c.text} strokeWidth={3} opacity={op} />;
          return <rect key={it.i} x={x - 22 * scale} y={y - 8 * scale} width={44 * scale} height={16 * scale} rx={8} fill="none" stroke={c.accent} strokeWidth={3} opacity={op} />;
        })}
        {/* 「？」が増えていく */}
        {Array.from({ length: 18 }, (_, i) => {
          const s0 = at(3) - 0.4 + random(`q${i}`) * 1.8;
          const p = interpolate(t, [s0, s0 + 0.35], [0, 1], { ...clamp, easing: ease });
          if (p <= 0) return null;
          return (
            <text key={i} x={260 + random(`qx${i}`) * 1200} y={250 + random(`qy${i}`) * 440} fill={c.warn} fontFamily={fontFamily} fontWeight={700} fontSize={40 + random(`qs${i}`) * 30} opacity={p * 0.9} textAnchor="middle" style={{ scale: String(0.6 + p * 0.4) }}>
              ？
            </text>
          );
        })}
      </svg>
      <AbsoluteFill style={{ flexDirection: 'row', justifyContent: 'center', gap: 70, top: 770, left: -100 }}>
        <Kicker from={s - start} style={{ fontSize: 40, fontWeight: 700, letterSpacing: 6 }}>
          <span style={{ color: c.red }}>◆</span> 患者
        </Kicker>
        <Kicker from={s + 1.05 - start} style={{ fontSize: 40, fontWeight: 700, letterSpacing: 6 }}>
          ○ 人
        </Kicker>
        <Kicker from={s + 1.95 - start} style={{ fontSize: 40, fontWeight: 700, letterSpacing: 6 }}>
          <span style={{ color: c.accent }}>▭</span> 物
        </Kicker>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
