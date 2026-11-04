import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig, random } from 'remotion';
import { clamp, ease, Kicker } from '../common';
import { dots, project } from '../japan';
import { c, fontFamily, useTiming } from '../theme';

const K = 40;
const MAP_X = 330;
const MAP_Y = 120;
const points = dots(0.32);

/** 場面1：自然災害が頻発する国で ／ 災害のたび、病院に患者が押し寄せる */
export const Disasters = ({ start }: { start: number }) => {
  const { at } = useTiming();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + start;
  const mapOut = interpolate(t, [at(1) - 0.3, at(1) + 0.6], [0, 1], { ...clamp, easing: ease });

  return (
    <AbsoluteFill>
      {/* 日本列島（点の並び） */}
      <AbsoluteFill style={{ opacity: 1 - mapOut * 0.82, scale: String(1 + mapOut * 0.25), translate: `${-mapOut * 260}px 0px` }}>
        <svg width={1920} height={1080}>
          <g transform={`translate(${MAP_X} ${MAP_Y})`}>
            {points.map((p, i) => {
              const { x, y } = project(p.lon, p.lat, K);
              const appear = interpolate(t, [0.05 + random(`d${i}`) * 0.9, 0.45 + random(`d${i}`) * 0.9], [0, 1], clamp);
              return <circle key={i} cx={x} cy={y} r={3.2} fill={c.accent} opacity={appear * 0.55} />;
            })}
            <Quake t={t} />
            <Rain t={t} />
            <Typhoon t={t} />
          </g>
        </svg>
      </AbsoluteFill>

      {/* 災害の名前 */}
      <AbsoluteFill style={{ left: 1180, top: 300, opacity: 1 - mapOut }}>
        {(['地震', '豪雨', '台風'] as const).map((w, i) => (
          <Kicker key={w} from={at(0) + i * 0.55 - start} style={{ fontSize: 96, fontWeight: 700, letterSpacing: 12, lineHeight: 1.35 }}>
            {w}
          </Kicker>
        ))}
        <Kicker from={at(0) + 1.9 - start} style={{ fontSize: 30, color: c.sub, marginTop: 28, letterSpacing: 4 }}>
          自然災害が頻発する国で
        </Kicker>
      </AbsoluteFill>

      <Hospital t={t} />
    </AbsoluteFill>
  );
};

const Quake = ({ t }: { t: number }) => {
  const { at } = useTiming();
  const { x, y } = project(141.6, 38.4, K);
  const s = at(0);
  return (
    <g>
      {[0, 1, 2].map((k) => {
        const p = ((t - s - k * 0.35) % 1.4) / 1.4;
        const on = t > s + k * 0.35;
        return <circle key={k} cx={x} cy={y} r={10 + p * 90} fill="none" stroke={c.warn} strokeWidth={3} opacity={on ? (1 - p) * 0.9 : 0} />;
      })}
      <circle cx={x} cy={y} r={7} fill={c.warn} opacity={interpolate(t, [s, s + 0.2], [0, 1], clamp)} />
    </g>
  );
};

const Rain = ({ t }: { t: number }) => {
  const { at } = useTiming();
  const { x, y } = project(130.7, 32.9, K);
  const s = at(0) + 0.55;
  if (t < s) return null;
  return (
    <g opacity={interpolate(t, [s, s + 0.3], [0, 1], clamp)}>
      {Array.from({ length: 16 }, (_, i) => {
        const ox = (random(`r${i}`) - 0.5) * 120;
        const fall = ((t * 2.2 + random(`ry${i}`)) % 1) * 110 - 70;
        return <line key={i} x1={x + ox} y1={y + fall} x2={x + ox - 8} y2={y + fall + 22} stroke={c.accent} strokeWidth={3} strokeLinecap="round" />;
      })}
    </g>
  );
};

const Typhoon = ({ t }: { t: number }) => {
  const { at } = useTiming();
  const s = at(0) + 1.1;
  if (t < s) return null;
  const p = interpolate(t, [s, s + 4], [0, 1], clamp);
  const { x, y } = project(131 + p * 3.5, 27.5 + p * 4, K);
  const arms = [0, 1, 2].map((k) => {
    const a0 = (k * 2 * Math.PI) / 3 - t * 4;
    const d = Array.from({ length: 24 }, (_, i) => {
      const r = 6 + i * 2.6;
      const a = a0 + i * 0.22;
      return `${i === 0 ? 'M' : 'L'}${x + Math.cos(a) * r} ${y + Math.sin(a) * r}`;
    }).join(' ');
    return <path key={k} d={d} fill="none" stroke={c.text} strokeWidth={3} strokeLinecap="round" opacity={0.8} />;
  });
  return <g opacity={interpolate(t, [s, s + 0.3], [0, 1], clamp)}>{arms}</g>;
};

/** 病院の輪郭と、流れ込む患者の点 */
const Hospital = ({ t }: { t: number }) => {
  const { at } = useTiming();
  const s = at(1) - 0.2;
  const show = interpolate(t, [s, s + 0.6], [0, 1], { ...clamp, easing: ease });
  if (show <= 0) return null;
  const bx = 1060;
  const by = 330;
  return (
    <AbsoluteFill style={{ opacity: show }}>
      <svg width={1920} height={1080}>
        {/* 建物：線だけで描く（赤十字の印は使わない） */}
        <g stroke={c.text} strokeWidth={3} fill="none" opacity={0.9}>
          <rect x={bx} y={by + 80} width={460} height={340} />
          <rect x={bx + 140} y={by} width={180} height={80} />
          {Array.from({ length: 3 }, (_, r) =>
            Array.from({ length: 5 }, (_, k) => <rect key={`${r}-${k}`} x={bx + 30 + k * 86} y={by + 110 + r * 74} width={52} height={40} strokeWidth={2} opacity={0.6} />),
          )}
          <rect x={bx + 190} y={by + 340} width={80} height={80} />
        </g>
        <text x={bx + 230} y={by + 56} fill={c.text} fontFamily={fontFamily} fontWeight={700} fontSize={44} textAnchor="middle">
          H
        </text>
        {/* 流れ込む点 */}
        {Array.from({ length: 70 }, (_, i) => {
          const delay = random(`p${i}`) * 2.6;
          const p = interpolate(t, [s + 0.3 + delay, s + 1.5 + delay], [0, 1], { ...clamp, easing: ease });
          if (p <= 0) return null;
          const y0 = 180 + random(`py${i}`) * 720;
          const x = interpolate(p, [0, 1], [-40, bx + 230 + (random(`px${i}`) - 0.5) * 60]);
          const y = interpolate(p, [0, 1], [y0, by + 400 + (random(`pz${i}`) - 0.5) * 30]);
          const col = [c.red, c.yellow, c.green][Math.floor(random(`pc${i}`) * 3)];
          return <circle key={i} cx={x} cy={y} r={7} fill={col} opacity={1 - p * 0.6} />;
        })}
      </svg>
    </AbsoluteFill>
  );
};
