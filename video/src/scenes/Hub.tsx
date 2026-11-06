// 「本部と部署を結ぶ図」。課題（無線とホワイトボード → 線が途切れる）と、解決（病院リンクBCPで全部の端末がつながる）を同じ図で見せる。
// variant='mini' は操作の場面の小さな地図。いま応答している部署を光らせ、情報が線を伝わる様子と患者の位置を出す。
import { interpolate, useCurrentFrame } from 'remotion';
import { clamp, ease } from '../common';
import { c, fontFamily, LOGO, logoFont } from '../theme';
import { Patient, Staff } from './HospitalPictogram';

export type NodeId = 'hq' | 'er' | 'or' | 'ward' | 'hall';
const NAMES: Record<NodeId, string> = { hq: '本部', er: '救急外来', or: '手術室', ward: '病棟', hall: '外来ホール' };
const DEPTS: NodeId[] = ['er', 'or', 'ward', 'hall'];

const FULL = { hq: { x: 960, y: 440 }, er: { x: 420, y: 250 }, or: { x: 1500, y: 250 }, ward: { x: 420, y: 630 }, hall: { x: 1500, y: 630 } };
const MINI = { hq: { x: 320, y: 105 }, er: { x: 85, y: 40 }, or: { x: 555, y: 40 }, ward: { x: 85, y: 170 }, hall: { x: 555, y: 170 } };

/** 端末（パソコン）の小さな印 */
const Pc = ({ x, y, s = 1, on = 1 }: { x: number; y: number; s?: number; on?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`} opacity={on}>
    <rect x={-20} y={-14} width={40} height={26} rx={3} fill={c.accentSoft} stroke={c.accent} strokeWidth={3} />
    <rect x={-5} y={12} width={10} height={4} fill={c.accent} />
  </g>
);

/** 患者の印（赤の札） */
const PatientMark = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x={-14} y={-12} width={28} height={24} fill={c.red} stroke="#000" strokeWidth={1} />
    <text x={0} y={6} fill="#fff" fontFamily={fontFamily} fontSize={16} fontWeight={700} textAnchor="middle">◆</text>
  </g>
);

/**
 * 全画面の図。
 * - radio：無線（破線）で本部と部署をつなぎ、本部はホワイトボードで集める（いまのやり方）
 * - broken：線が途切れて、患者・人・物が「？」（課題）
 * - connected：病院リンクBCPで全部の端末がつながり、本部に同じ記録が集まる（解決）
 */
export const Hub = ({ state }: { state: 'radio' | 'broken' | 'connected' | 'triage' | 'training' }) => {
  const frame = useCurrentFrame();
  const P = FULL;
  const { x: cx, y: cy } = P.hq;
  const training = state === 'training';
  const connected = state === 'connected' || state === 'triage' || training;
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
      {DEPTS.map((id, i) => {
        const d = P[id];
        const p = interpolate(frame, [4 + i * 5, 16 + i * 5], [0, 1], { ...clamp, easing: ease });
        const br = state === 'broken' ? interpolate(frame, [26 + i * 6, 36 + i * 6], [0, 1], clamp) : 0;
        const mx = (cx + d.x) / 2, my = (cy + d.y) / 2;
        // つながったとき：線の上を情報の点が行き来する
        // 部署 → 本部（報告・依頼）と、本部 → 部署（返事・指示）を交互に。部署ごとに少しずらす
        const cyc = ((frame / 30) * 0.45 + i * 0.25) % 1;
        const toHq = cyc < 0.5;
        const k0 = toHq ? cyc * 2 : (cyc - 0.5) * 2;
        const k = k0 < 0.5 ? 2 * k0 * k0 : 1 - (-2 * k0 + 2) ** 2 / 2;
        const dot = toHq ? { x: d.x + (cx - d.x) * k, y: d.y + (cy - d.y) * k } : { x: cx + (d.x - cx) * k, y: cy + (d.y - cy) * k };
        const aiNode = training && (id === 'or' || id === 'hall');
        const stroke = aiNode ? c.warn : connected ? c.accent : c.line;
        const dash = state === 'radio' ? '14 10' : undefined;
        return (
          <g key={id} opacity={p}>
            <line x1={cx} y1={cy} x2={mx - (mx - cx) * 0.12 * br} y2={my - (my - cy) * 0.12 * br} stroke={stroke} strokeWidth={connected ? 5 : 3} strokeDasharray={aiNode ? '14 10' : dash} />
            <line x1={mx + (d.x - mx) * 0.12 * br} y1={my + (d.y - my) * 0.12 * br} x2={d.x} y2={d.y} stroke={stroke} strokeWidth={connected ? 5 : 3} strokeDasharray={aiNode ? '14 10' : dash} />
            {state === 'broken' && <text x={mx} y={my + 14} fill={c.red} fontFamily={fontFamily} fontSize={44} fontWeight={700} textAnchor="middle" opacity={br}>✕</text>}
            {state === 'radio' && <text x={mx} y={my - 14} fill={c.sub} fontFamily={fontFamily} fontSize={22} textAnchor="middle">無線</text>}
            {training && <circle cx={dot.x} cy={dot.y} r={11} fill={aiNode ? c.warn : c.accent} stroke="#fff" strokeWidth={2} />}
            {state === 'connected' && <circle cx={dot.x} cy={dot.y} r={11} fill={toHq ? c.warn : c.accent} stroke="#fff" strokeWidth={2} opacity={interpolate(frame, [20, 30], [0, 1], clamp)} />}
            <rect x={d.x - 150} y={d.y - 50} width={300} height={100} fill="rgba(7,13,24,0.92)" stroke={aiNode ? c.warn : connected ? c.accent : c.line} strokeWidth={connected ? 3 : 2} strokeDasharray={aiNode ? '12 8' : undefined} />
            {training && <><rect x={d.x - 150} y={d.y + 58} width={300} height={40} fill={c.bg} /><text x={d.x} y={d.y + 88} fill={c.warn} fontFamily={fontFamily} fontSize={26} fontWeight={700} textAnchor="middle">{id === 'or' ? '判断：Claude' : id === 'hall' ? '無線：Claude' : '催促：Claude'}</text></>}
            <text x={d.x - (connected && !training ? 30 : 0)} y={d.y + 10} fill={c.text} fontFamily={fontFamily} fontSize={30} fontWeight={700} textAnchor="middle">{training && id === 'hall' ? '搬送要員' : NAMES[id]}</text>
            {connected && !training && <Pc x={d.x + 100} y={d.y} on={interpolate(frame, [12 + i * 4, 22 + i * 4], [0, 1], clamp)} />}
          </g>
        );
      })}
      {/* 本部 */}
      <rect x={cx - 150} y={cy - 60} width={300} height={120} fill={c.bg2} stroke={c.accent} strokeWidth={connected ? 5 : 3} />
      <text x={cx} y={cy + 12} fill={c.text} fontFamily={fontFamily} fontSize={34} fontWeight={700} textAnchor="middle">本部</text>
      {training && <><rect x={cx - 120} y={cy + 68} width={240} height={44} fill={c.bg} /><text x={cx} y={cy + 100} fill={c.text} fontFamily={fontFamily} fontSize={30} fontWeight={700} textAnchor="middle">あなたが操作</text></>}
      {state === 'connected' && (
        <g opacity={interpolate(frame, [24, 36], [0, 1], clamp)}>
          <rect x={cx - 150} y={cy - 116} width={300} height={48} fill={c.bg} />
          <text x={cx} y={cy - 80} fill={c.accent} fontFamily={logoFont} fontSize={32} fontWeight={700} textAnchor="middle" letterSpacing={2}>{LOGO.ja}</text>
        </g>
      )}
      {state === 'triage' && (
        <g>
          {([
            // 災害運用モードの区切り（約3秒）が明けてから動かす
            ['red', 'or', 80],
            ['yellow', 'ward', 125],
            ['green', 'hall', 170],
          ] as const).map(([tri, to, at], i) => {
            // 1人ずつ、約2秒かけてゆっくり運ぶ
            const k = interpolate(frame, [at, at + 58], [0, 1], { ...clamp, easing: ease });
            const from = { x: P.er.x - 110 + i * 110, y: P.er.y + 140 };
            const dest = { x: P[to].x - 40, y: P[to].y + 140 };
            const x = from.x + (dest.x - from.x) * k;
            const y = from.y + (dest.y - from.y) * k;
            return (
              <g key={tri} opacity={interpolate(frame, [4, 14], [0, 1], clamp)}>
                <Patient x={x} y={y} s={1.15} tri={tri} />
                <Staff x={x + 70} y={y + 12} s={0.9} />
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
};

/** 小さな地図（操作の場面）。active：いま応答している所、flow：情報が伝わる向き、patient：患者のいる所（move なら救急外来→手術室へ動く） */
export const HubMini = ({ active, flow, done = [], patient = 'er', move = 0, left = 1248, top = 52, ai = false }: { active: NodeId[]; flow?: [NodeId, NodeId][]; done?: NodeId[]; patient?: NodeId | 'move' | null; move?: number; left?: number; top?: number; ai?: boolean }) => {
  // 訓練（ai）：手術室と搬送要員（外来ホールの位置）が Claude。救急外来・病棟は端末で記録（支援要請の催促は Claude。大きな図の「催促：Claude」）
  const isAi = (id: NodeId) => ai && (id === 'or' || id === 'hall');
  const frame = useCurrentFrame();
  const P = MINI;
  const p = interpolate(frame, [0, 12], [0, 1], { ...clamp, easing: ease });
  const k = ((frame / 30) * 1.1) % 1;
  const pp = patient === 'move' || patient === null ? (patient === null ? { x: 0, y: 0 } : { x: P.er.x + (P.or.x - P.er.x) * move, y: P.er.y - 2 }) : { x: P[patient].x + 48, y: P[patient].y - 2 };
  return (
    <svg width={640} height={215} style={{ position: 'absolute', left, top, opacity: p, overflow: 'visible' }}>
      <rect x={-16} y={-34} width={672} height={262} rx={10} fill="rgba(7,13,24,0.88)" stroke={c.line} strokeWidth={2} />
      {DEPTS.map((id) => {
        const lit = flow?.some(([a, b]) => (a === id && b === 'hq') || (a === 'hq' && b === id));
        const used = done.includes(id);
        return <line key={id} x1={P.hq.x} y1={P.hq.y} x2={P[id].x} y2={P[id].y} stroke={lit ? c.warn : used ? c.accent : c.line} strokeWidth={lit ? 5 : used ? 4 : 2} />;
      })}
      {patient === 'move' && <line x1={P.er.x} y1={P.er.y} x2={P.or.x} y2={P.or.y} stroke={c.warn} strokeWidth={3} strokeDasharray="8 6" />}
      {flow?.map(([a, b], i) => (
        <circle key={i} cx={P[a].x + (P[b].x - P[a].x) * k} cy={P[a].y + (P[b].y - P[a].y) * k} r={7} fill={c.warn} />
      ))}
      {(['hq', ...DEPTS] as NodeId[]).map((id) => {
        const on = active.includes(id);
        const w = id === 'hq' ? 150 : 140;
        return (
          <g key={id}>
            <rect x={P[id].x - w / 2} y={P[id].y - 22} width={w} height={44} fill={on ? '#2a2414' : '#0b1322'} stroke={on ? c.warn : id === 'hq' ? c.accent : isAi(id) ? c.warn : c.line} strokeWidth={on ? 4 : 2} strokeDasharray={isAi(id) ? '8 5' : undefined} />
            <text x={P[id].x} y={P[id].y + 8} fill={on ? c.text : c.sub} fontFamily={fontFamily} fontSize={id === 'hq' ? 24 : 21} fontWeight={700} textAnchor="middle">{ai && id === 'hall' ? '搬送要員' : NAMES[id]}</text>
          </g>
        );
      })}
      {patient !== null && <PatientMark x={pp.x} y={pp.y - 24} s={0.85} />}
    </svg>
  );
};

/** 病院の大小を同じ図で比べる：左は部署の多い総合病院、右は部署の少ない中規模病院。どちらにも同じ画面（パソコン）が入る */
export const HubCompare = () => {
  const frame = useCurrentFrame();
  const p = (k: number) => interpolate(frame, [k, k + 16], [0, 1], { ...clamp, easing: ease });
  const panel = (cx: number, cy: number, r: number, names: string[], title: string, k: number) => (
    <g opacity={p(k)}>
      <text x={cx} y={cy - r - 70} fill={c.text} fontFamily={fontFamily} fontSize={44} fontWeight={700} textAnchor="middle">{title}</text>
      {names.map((n, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / names.length;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.8;
        return <line key={`l${n}`} x1={cx} y1={cy} x2={x} y2={y} stroke={c.accent} strokeWidth={3} />;
      })}
      {names.map((n, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / names.length;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.8;
        return (
          <g key={n}>
            <rect x={x - 100} y={y - 26} width={200} height={52} fill="#0b1322" stroke={c.accent} strokeWidth={2} />
            <text x={x - 18} y={y + 8} fill={c.text} fontFamily={fontFamily} fontSize={22} fontWeight={700} textAnchor="middle">{n}</text>
            <Pc x={x + 72} y={y} s={0.7} />
          </g>
        );
      })}
      <rect x={cx - 80} y={cy - 32} width={160} height={64} fill={c.bg2} stroke={c.accent} strokeWidth={4} />
      <text x={cx} y={cy + 10} fill={c.text} fontFamily={fontFamily} fontSize={28} fontWeight={700} textAnchor="middle">本部</text>
    </g>
  );
  return (
    <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
      {panel(500, 470, 290, ['救急外来', '手術室', '外来ホール', '病棟A', '病棟B', '講堂', 'ICU', '検査室'], '総合病院', 0)}
      {panel(1420, 470, 230, ['外来処置室', '病棟', '外来待合'], '中規模病院', 30)}
    </svg>
  );
};
