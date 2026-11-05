import type { CommandEnvelopeInput } from './commands';
import type { HospitalConfig } from './config';
import type { Decider } from './events';
import type { Scenario } from './scenario';
import { TRANSPORTER_ROLE, type SimView } from './simulator';
import { versionOf, type AppState } from './state';

// 「このツールを使った訓練」：部署の端末から参加者のボードに記録するもの。
// 患者の登録・受け入れ状況・支援要請・到着・支援の受け取りは、シナリオのプログラムが部署の端末から記録する
// （区分や特徴はシナリオの作者が書いた値で、AI は決めない）。受け入れの了承・断りは、部署役（AI）の判断を
// シミュレーターが検証したものだけを記録する。どれも、ふつうの端末と同じ検証（decide）を通してから記録する。
// 本部（参加者）は、この記録を画面で見て、搬送と支援の調整を練習する。

export interface BoardWrite {
  /** 同じものを二度記録しないための目印 */
  key: string;
  /** シナリオの出来事から作った記録なら、その番号 */
  timelineIndex?: number;
  envelope: CommandEnvelopeInput;
  /** 同じタッグ番号などの警告が出たときに、理由を付けて記録してよいか（部署の端末で、確かめて登録した扱い） */
  overrideReason?: string;
}

/** その部署の端末で入力する職員（病院設定でその場所にいる職員の最初の人。いなければ場所の決まっていない職員） */
export function staffAt(config: HospitalConfig, locationId: string): string | null {
  return (config.staff.find((s) => s.locationId === locationId) ?? config.staff.find((s) => !s.locationId))?.id ?? null;
}

/** 受け入れを判断する人（到着先の責任者の役職。なければその場所の職員） */
function deciderAt(config: HospitalConfig, locationId: string): Decider {
  const position = config.positions.find((p) => p.locationId === locationId && p.permissions.includes('accept-transport'));
  if (position) return { positionId: position.id, asDeputy: false };
  const staff = staffAt(config, locationId);
  return staff ? { staffId: staff, asDeputy: false } : { name: '部署の担当者（訓練の部署役）', asDeputy: false };
}

export function pendingBoardWrites(view: SimView, scenario: Scenario, config: HospitalConfig, board: AppState): BoardWrite[] {
  const out: BoardWrite[] = [];
  if (!view.runId) return out;
  const meta = (locationId: string) => ({ enteredBy: staffAt(config, locationId) ?? '', terminal: locationId, reportedBy: null });
  const add = (w: BoardWrite) => {
    if (view.boardWritten.has(w.key) || !w.envelope.meta.enteredBy) return;
    out.push(w);
  };

  // 1. シナリオの出来事：部署の端末から記録する
  scenario.timeline.forEach((t, i) => {
    if (!view.fired.has(i)) return;
    const key = `timeline-${i}`;
    if (t.type === 'patientArrives') {
      const p = t.patient;
      add({
        key,
        timelineIndex: i,
        envelope: {
          command: { type: 'RegisterPatient', payload: { locationId: t.locationId, triage: p.triage, tagNumber: p.tagNumber, sex: p.sex, estimatedAge: p.estimatedAge, features: p.features } },
          meta: meta(t.locationId),
        },
        overrideReason: '部署で特徴を確かめ、別の患者として登録した（訓練の部署役）',
      });
    }
    if (t.type === 'locationStatus') {
      add({
        key,
        timelineIndex: i,
        envelope: {
          command: { type: 'ReportLocationStatus', locationId: t.locationId, payload: { accepting: t.accepting, capacity: t.capacity ?? [], note: t.note } },
          meta: meta(t.locationId),
        },
      });
    }
    if (t.type === 'supportNeed') {
      add({
        key,
        timelineIndex: i,
        envelope: { command: { type: 'RequestSupport', payload: { fromLocationId: t.locationId, kindId: t.kindId, items: t.items, note: t.note } }, meta: meta(t.locationId) },
      });
    }
    if (t.type === 'notice' && t.reporter !== TRANSPORTER_ROLE) {
      add({
        key,
        timelineIndex: i,
        envelope: { command: { type: 'LogMessage', payload: { channel: 'other', fromLocationId: t.reporter, toLocationId: undefined, text: t.text, relatedIds: [] } }, meta: meta(t.reporter) },
      });
    }
  });

  // 2. 部署役（AI）の受け入れの判断：検証を通ったものを、到着先の端末から記録する
  for (const r of view.proposals) {
    if (!r.accepted || !r.proposal || r.role === TRANSPORTER_ROLE) continue;
    const p = r.proposal;
    if (p.action !== 'accept_transport' && p.action !== 'decline_transport') continue;
    const bt = board.transports[p.transportId];
    if (!bt || bt.retracted || bt.closed || bt.steps.accepted || bt.steps.declined) continue;
    const subject = { kind: 'transport' as const, id: bt.id };
    add({
      key: `decision-${r.stimulusId}`,
      envelope:
        p.action === 'accept_transport'
          ? { command: { type: 'AcceptTransport', transportId: bt.id, payload: { decidedBy: deciderAt(config, bt.toLocationId), note: p.message } }, meta: meta(bt.toLocationId), expectedVersion: versionOf(board, subject) }
          : { command: { type: 'DeclineTransport', transportId: bt.id, payload: { decidedBy: deciderAt(config, bt.toLocationId), reason: `${p.reason}（${p.message}）` } }, meta: meta(bt.toLocationId), expectedVersion: versionOf(board, subject) },
    });
  }

  // 3. 到着：到着先の端末から記録する（搬送要員は、無線で本部に到着を伝える）
  for (const t of Object.values(view.transports)) {
    if (t.arrivedSimMs === undefined) continue;
    const bt = board.transports[t.id];
    if (!bt || bt.retracted || bt.steps.arrived || bt.steps.cancelled) continue;
    add({ key: `arrival-${t.id}`, envelope: { command: { type: 'RecordArrival', transportId: t.id, payload: {} }, meta: meta(t.toLocationId), expectedVersion: versionOf(board, { kind: 'transport', id: t.id }) } });
  }

  // 4. 支援の受け取り：要請した部署の端末から記録する
  for (const s of Object.values(view.supports)) {
    if (s.deliveredSimMs === undefined) continue;
    const bs = board.supports[s.id];
    if (!bs || bs.retracted || bs.steps.received || bs.closed) continue;
    add({ key: `received-${s.id}`, envelope: { command: { type: 'RecordSupportReceived', supportId: s.id, payload: {} }, meta: meta(s.fromLocationId), expectedVersion: versionOf(board, { kind: 'support', id: s.id }) } });
  }
  return out;
}
