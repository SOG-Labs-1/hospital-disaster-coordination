// 病院の様子を、人と患者を模した図で見せる（3分版）。病院の中を知らない人にも、どこで何が起きるかが分かるように。
// 配置は架空の「Claude総合病院(仮)」（config/hospitals/claude.yaml の場所）をもとにした簡略図。実在の病院ではない。
import type { ReactNode } from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { clamp, ease } from '../common';
import { c, fontFamily } from '../theme';

const TRI = { red: { col: c.red, sym: '◆' }, yellow: { col: c.yellow, sym: '▲' }, green: { col: c.green, sym: '●' } } as const;
type Tri = keyof typeof TRI;

/** 立っている職員（白い線の人の形） */
export const Staff = ({ x, y, s = 1, color = c.text, label }: { x: number; y: number; s?: number; color?: string; label?: string }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <circle cx={0} cy={-38} r={9} fill="none" stroke={color} strokeWidth={3} />
    <path d="M -13 -24 Q 0 -30 13 -24 L 11 4 L -11 4 Z" fill="none" stroke={color} strokeWidth={3} strokeLinejoin="round" />
    <line x1={-6} y1={4} x2={-7} y2={22} stroke={color} strokeWidth={3} />
    <line x1={6} y1={4} x2={7} y2={22} stroke={color} strokeWidth={3} />
    {label && <text x={0} y={42} fill={c.sub} fontFamily={fontFamily} fontSize={16} textAnchor="middle">{label}</text>}
  </g>
);

/** ストレッチャーに横になった患者。区分の札（色＋記号）つき */
export const Patient = ({ x, y, s = 1, tri = 'red', tag }: { x: number; y: number; s?: number; tri?: Tri; tag?: string }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <line x1={-40} y1={6} x2={40} y2={6} stroke={c.accent} strokeWidth={4} />
    <line x1={-32} y1={6} x2={-32} y2={20} stroke={c.accent} strokeWidth={3} />
    <line x1={32} y1={6} x2={32} y2={20} stroke={c.accent} strokeWidth={3} />
    <circle cx={-26} cy={-6} r={8} fill="none" stroke={c.text} strokeWidth={3} />
    <rect x={-16} y={-12} width={50} height={14} rx={7} fill="none" stroke={c.text} strokeWidth={3} />
    <g transform="translate(8 -30)">
      <rect x={-14} y={-12} width={28} height={22} fill={TRI[tri].col} stroke="#000" strokeWidth={1} />
      <text x={0} y={5} fill={tri === 'yellow' ? '#000' : '#fff'} fontFamily={fontFamily} fontSize={14} fontWeight={700} textAnchor="middle">{TRI[tri].sym}</text>
    </g>
    {tag && <text x={36} y={-26} fill={c.text} fontFamily={fontFamily} fontSize={16}>{tag}</text>}
  </g>
);

/** 座って待つ患者（軽症） */
const Seated = ({ x, y, tri }: { x: number; y: number; tri: Tri }) => (
  <g transform={`translate(${x} ${y})`}>
    <circle cx={0} cy={-26} r={8} fill="none" stroke={c.text} strokeWidth={3} />
    <path d="M -10 -14 L 10 -14 L 10 4 L 18 4 L 18 16" fill="none" stroke={c.text} strokeWidth={3} strokeLinejoin="round" />
    <line x1={-10} y1={-14} x2={-10} y2={16} stroke={c.text} strokeWidth={3} />
    <text x={-22} y={-20} fill={TRI[tri].col} fontFamily={fontFamily} fontSize={18} fontWeight={700} textAnchor="middle">{TRI[tri].sym}</text>
  </g>
);

/** パソコン（端末）の印 */
const Pc = ({ x, y, on }: { x: number; y: number; on: number }) => (
  <g transform={`translate(${x} ${y})`} opacity={on}>
    <rect x={-30} y={-22} width={60} height={38} rx={4} fill={c.accentSoft} stroke={c.accent} strokeWidth={3} />
    <rect x={-8} y={17} width={16} height={6} fill={c.accent} />
    <rect x={-18} y={23} width={36} height={4} fill={c.accent} />
  </g>
);

type Room = { id: string; name: string; role: string; x: number; y: number; w: number; h: number };
// 2階建ての断面図（上：2階、下：1階）
const ROOMS: Room[] = [
  { id: 'hq', name: '本部（災害対策本部）', role: '院内全体を調整する司令塔', x: 150, y: 150, w: 560, h: 260 },
  { id: 'or', name: '手術室', role: '重い患者の手術', x: 730, y: 150, w: 420, h: 260 },
  { id: 'ward', name: '病棟', role: '入院中の患者', x: 1170, y: 150, w: 600, h: 260 },
  { id: 'er', name: '救急外来', role: '重い患者を受け入れる', x: 150, y: 430, w: 760, h: 260 },
  { id: 'hall', name: '外来ホール', role: '軽い患者が待つ', x: 930, y: 430, w: 840, h: 260 },
];

/** 病院の断面図。phase='overview' は人と患者、'terminals' は場所ごとの端末が灯る */
export const HospitalPictogram = ({ phase }: { phase: 'overview' | 'terminals' }) => {
  const frame = useCurrentFrame();
  const appear = (k: number) => interpolate(frame, [k, k + 14], [0, 1], { ...clamp, easing: ease });
  const term = (i: number) => (phase === 'terminals' ? appear(10 + i * 7) : 0);
  const people = phase === 'overview' ? 1 : 0.35;
  const room = (r: Room, i: number, children: ReactNode) => (
    <g key={r.id} opacity={appear(i * 5)}>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(88,196,255,0.05)" stroke={c.line} strokeWidth={2} />
      <text x={r.x + 18} y={r.y + 38} fill={c.text} fontFamily={fontFamily} fontSize={28} fontWeight={700}>{r.name}</text>
      <text x={r.x + 18} y={r.y + 70} fill={c.sub} fontFamily={fontFamily} fontSize={20}>{r.role}</text>
      <g opacity={people}>{children}</g>
      <Pc x={r.x + r.w - 60} y={r.y + 50} on={term(i)} />
    </g>
  );
  const [hq, or, ward, er, hall] = ROOMS as [Room, Room, Room, Room, Room];
  return (
    <svg width={1920} height={1080}>
      {/* 建物の外形と階 */}
      <rect x={130} y={130} width={1660} height={580} fill="none" stroke={c.text} strokeWidth={3} opacity={0.6} />
      <text x={100} y={285} fill={c.sub} fontFamily={fontFamily} fontSize={22} textAnchor="middle">2階</text>
      <text x={100} y={565} fill={c.sub} fontFamily={fontFamily} fontSize={22} textAnchor="middle">1階</text>
      {room(hq, 0, (
        <>
          <Staff x={260} y={350} label="本部長" />
          <Staff x={350} y={350} label="記録係" />
          <Staff x={440} y={350} label="搬送の調整" />
          {/* 大型モニター（掲示用画面） */}
          <rect x={520} y={225} width={150} height={88} fill={c.bg2} stroke={c.accent} strokeWidth={3} />
          <text x={595} y={275} fill={c.accent} fontFamily={fontFamily} fontSize={18} textAnchor="middle">状況を表示</text>
          <text x={595} y={337} fill={c.sub} fontFamily={fontFamily} fontSize={18} textAnchor="middle">大型モニター</text>
        </>
      ))}
      {room(or, 1, (
        <>
          <Patient x={900} y={330} tri="red" />
          <Staff x={1020} y={350} />
          <Staff x={1080} y={350} />
        </>
      ))}
      {room(ward, 2, (
        <>
          <Patient x={1290} y={330} tri="yellow" />
          <Patient x={1450} y={330} tri="yellow" />
          <Staff x={1620} y={350} />
        </>
      ))}
      {room(er, 3, (
        <>
          <Patient x={300} y={620} tri="red" />
          <Patient x={500} y={620} tri="red" />
          <Staff x={640} y={640} label="医師" />
          <Staff x={720} y={640} label="看護師" />
          <Staff x={800} y={640} label="看護師" />
        </>
      ))}
      {room(hall, 4, (
        <>
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <Seated key={k} x={1020 + k * 100} y={650} tri={k % 3 === 0 ? 'yellow' : 'green'} />
          ))}
          <Staff x={1690} y={640} label="看護師" />
        </>
      ))}
      {/* 凡例 */}
      <g opacity={appear(30)}>
        <Staff x={190} y={770} s={0.8} />
        <text x={220} y={768} fill={c.sub} fontFamily={fontFamily} fontSize={22}>職員</text>
        <Patient x={360} y={766} s={0.7} tri="red" />
        <text x={400} y={768} fill={c.sub} fontFamily={fontFamily} fontSize={22}>患者（札の色と記号＝治療の急ぎ具合）</text>
      </g>
    </svg>
  );
};

/** 通しの場面の上に出す小さな地図：救急外来・本部・手術室と、患者の位置。step で進み具合を変える */
export const FlowMap = ({ step, progress = 0 }: { step: 'register' | 'request' | 'move'; progress?: number }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, 14], [0, 1], { ...clamp, easing: ease });
  const boxes = [
    { id: 'hq', name: '本部', x: 0 },
    { id: 'er', name: '救急外来', x: 330 },
    { id: 'or', name: '手術室', x: 660 },
  ];
  const lit = { register: ['er', 'hq'], request: ['hq', 'or'], move: ['er', 'or', 'hq'] }[step];
  // 患者の位置：搬送中は救急外来から手術室へ動く
  const px = step === 'move' ? interpolate(progress, [0, 1], [480, 810], clamp) : 480;
  return (
    <svg width={1100} height={150} style={{ position: 'absolute', left: 80, top: 92, opacity: p }}>
      {boxes.map((b) => {
        const on = lit.includes(b.id);
        return (
          <g key={b.id}>
            <rect x={b.x + 4} y={10} width={300} height={130} fill={on ? 'rgba(88,196,255,0.12)' : 'rgba(88,196,255,0.03)'} stroke={on ? c.accent : c.line} strokeWidth={on ? 3 : 2} />
            <text x={b.x + 20} y={40} fill={on ? c.text : c.sub} fontFamily={fontFamily} fontSize={24} fontWeight={700}>{b.name}</text>
          </g>
        );
      })}
      {step !== 'register' && (
        <path d="M 490 128 Q 650 146 800 128" fill="none" stroke={c.warn} strokeWidth={3} strokeDasharray={step === 'request' ? '10 8' : undefined} />
      )}
      <Patient x={px} y={96} s={0.85} tri="red" tag={step === 'register' ? 'タッグ110' : undefined} />
      {step === 'move' && <Staff x={px + 60} y={112} s={0.7} />}
      {step === 'register' && <Staff x={580} y={112} s={0.7} />}
      <Staff x={150} y={112} s={0.7} />
    </svg>
  );
};

/** トリアージの説明：札の付いた患者が、救急外来から手術室（治療できる場所）へ運ばれる矢印。HospitalPictogram の上に重ねる */
export const TriageRoute = () => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [6, 60], [0, 1], { ...clamp, easing: ease });
  // 救急外来の患者（300,620）から手術室（900,330）へ
  const x = interpolate(p, [0, 1], [300, 900]);
  const y = interpolate(p, [0, 1], [620, 330]) - Math.sin(p * Math.PI) * 60;
  const show = interpolate(frame, [0, 10], [0, 1], clamp);
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
      <g opacity={show}>
        <path d="M 300 600 Q 560 360 900 310" fill="none" stroke={c.warn} strokeWidth={5} strokeDasharray="14 10" />
        <polygon points="900,310 878,300 884,322" fill={c.warn} />
        <Patient x={x} y={y} s={1.1} tri="red" />
        <rect x={860} y={700} width={940} height={96} fill="rgba(7,13,24,0.95)" stroke={c.warn} strokeWidth={2} />
        <text x={1330} y={738} fill={c.warn} fontFamily={fontFamily} fontSize={22} fontWeight={700} textAnchor="middle">トリアージタッグ＝治療の急ぎ具合を色で示す札（区分は医師・看護師が決める）</text>
        <text x={1330} y={776} fill={c.text} fontFamily={fontFamily} fontSize={26} textAnchor="middle">◆赤 ＞ ▲黄 ＞ ●緑　重い患者から、治療できる場所へ</text>
      </g>
    </svg>
  );
};
