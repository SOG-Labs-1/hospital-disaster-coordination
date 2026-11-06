import type { HospitalConfig } from './config';
import type { DomainEvent, SupportItem } from './events';
import type { Proposal } from './proposals';
import type { Scenario, ScenarioPatient } from './scenario';
import { dict, normalizeIdentifier, reduce, type AppState } from './state';

// 訓練のシミュレーター（純粋な関数）。
// - 「実際の状態（truth）」をシナリオと時間から作る。参加者の「ボード」（訓練の記録）とは別に持つ
// - 参加者のボードの記録を見て、関係する部署役に「刺激（stimulus）」を送る
// - 部署役（AI または mock）の提案を検証し、正しいものだけを実際の状態と本部への連絡に反映する
// - ボードは一切変えない。本部への連絡を聞いて入力するのは参加者
// シミュレーターの記録（SimEvent）も追記のみ。状態は記録から集計する。

// ---- 部署役への刺激 ----

export type Stimulus =
  | { kind: 'patientArrived'; patient: ScenarioPatient }
  | { kind: 'statusChanged'; accepting?: boolean; capacity?: { triage: string; value: number }[]; note?: string }
  | { kind: 'needSupport'; kindId: string; items: SupportItem[]; note?: string }
  | { kind: 'notice'; text: string }
  | { kind: 'transportRequest'; transportId: string; patientText: string; fromLocationId: string }
  | { kind: 'transportOrdered'; transportId: string; patientText: string; toLocationId: string }
  | { kind: 'patientArrivedByTransport'; transportId: string; patientText: string; fromLocationId: string }
  | { kind: 'supportArrived'; supportId: string; itemsText: string }
  /** 自部署の支援要請が、手配されないまま時間がたった（端末から本部に催促する） */
  | { kind: 'supportFollowUp'; supportId: string; itemsText: string; note?: string; assigned: boolean; waitedMinutes: number }
  /** 本部が自部署の支援要請の手配を記録した（端末から短く返事をする） */
  | { kind: 'supportArranged'; supportId: string; itemsText: string; providerText: string }
  | { kind: 'hqMessage'; text: string };

/** 搬送要員の役（AI）。本部と無線でやりとりするのは、この役だけ */
export const TRANSPORTER_ROLE = 'transporter';

// ---- シミュレーターの記録 ----

type SimBase = { id: string; at: string };
export type SimEvent = SimBase &
  (
    | { type: 'RunStarted'; runId: string; scenarioId: string; hospitalId: string; provider: string }
    | { type: 'ClockChanged'; running: boolean; speed: number }
    | { type: 'ScenarioEventFired'; index: number; simMs: number }
    | { type: 'BoardObserved'; boardEventId: string; simMs: number }
    | { type: 'StimulusQueued'; stimulusId: string; role: string; stimulus: Stimulus; dueSimMs: number }
    | { type: 'StimulusDispatched'; stimulusId: string; simMs: number }
    | {
        type: 'ProposalResolved';
        stimulusId: string;
        role: string;
        proposal: Proposal | null;
        accepted: boolean;
        reason?: string;
        /** 受け入れた提案の言葉を本部への連絡として届けたときの番号 */
        messageId?: string;
        simMs: number;
      }
    | { type: 'MessageFromHQ'; messageId: string; to: string; text: string; simMs: number }
    | { type: 'MessageHeard'; messageId: string }
    | { type: 'TransportObserved'; transport: TruthTransport }
    | { type: 'TransportOrderedInSim'; transportId: string; simMs: number }
    | { type: 'TransportRedirectedInSim'; transportId: string; toLocationId: string }
    | { type: 'TransportCancelledInSim'; transportId: string }
    | { type: 'SupportObserved'; supportId: string; fromLocationId: string; simMs?: number }
    | { type: 'SupportDispatchedInSim'; supportId: string; simMs: number }
    | { type: 'TransportArrivedInSim'; transportId: string; simMs: number }
    | { type: 'SupportDeliveredInSim'; supportId: string; simMs: number }
    | { type: 'RunEnded'; simMs: number; reason: 'time' | 'manual' }
    /** 部署役（AI）の返事に失敗し、決まった返事（mock）で補った */
    | { type: 'ProviderFailed'; stimulusId: string; error: string }
    | { type: 'ReviewNoteAdded'; findingId: string; note: string }
    | { type: 'ReviewExplained'; provider: string; explanations: { findingId: string; text: string; evidence: string[] }[] }
    /** 部署の端末から、参加者のボードに記録した（部署役の入力。ふつうの端末と同じ検証を通す） */
    | { type: 'BoardWritten'; key: string; ok: boolean; error?: string; timelineIndex?: number; boardIds?: string[]; decisionFor?: string; declinedInstead?: boolean }
    /** 参加者がボードに記録した受け入れの了承・断り（部署役のいない行き先など）。実際の状態にも反映する */
    | { type: 'TransportDecisionObserved'; transportId: string; accepted: boolean }
  );
export type SimEventInput = SimEvent extends infer E ? (E extends SimEvent ? Omit<E, 'id' | 'at'> : never) : never;

// ---- 集計した状態 ----

export interface TruthPatient extends ScenarioPatient {
  locationId: string;
  arrivedSimMs: number;
}

export interface TruthTransport {
  id: string;
  boardPatientId: string;
  /** 実際の患者（シナリオの key）。ボードの記録から特定できなければ null */
  patientKey: string | null;
  fromLocationId: string;
  toLocationId: string;
  /** 部署役が了承（true）・断り（false）したか */
  roleAccepted: boolean | null;
  orderedSimMs?: number;
  departedSimMs?: number;
  arrivedSimMs?: number;
  cancelled: boolean;
}

export interface TruthSupport {
  id: string;
  fromLocationId: string;
  /** ボードに要請が記録された時刻（シナリオの時間） */
  requestedSimMs?: number;
  dispatchedSimMs?: number;
  deliveredSimMs?: number;
}

export interface InboxMessage {
  messageId: string;
  from: string;
  text: string;
  simMs: number;
  heard: boolean;
  action: Proposal['action'];
}

export interface SimView {
  runId: string | null;
  scenarioId: string | null;
  provider: string | null;
  startedAt: string | null;
  /** 時計の区切り（壁時計の時刻、動いているか、速さ） */
  clock: { at: number; running: boolean; speed: number }[];
  ended: { simMs: number; reason: 'time' | 'manual' } | null;
  fired: Set<number>;
  observed: Set<string>;
  stimuli: Map<string, { role: string; stimulus: Stimulus; dueSimMs: number; dispatched: boolean; resolved: boolean }>;
  patients: Record<string, TruthPatient>;
  locations: Record<string, { accepting: boolean; capacity: Record<string, number>; staff: Record<string, number>; note?: string }>;
  transports: Record<string, TruthTransport>;
  supports: Record<string, TruthSupport>;
  needs: { locationId: string; kindId: string; items: SupportItem[]; note?: string; requested: boolean }[];
  inbox: InboxMessage[];
  outbox: { messageId: string; to: string; text: string; simMs: number }[];
  proposals: Extract<SimEvent, { type: 'ProposalResolved' }>[];
  notes: Record<string, string>;
  explanations: Extract<SimEvent, { type: 'ReviewExplained' }> | null;
  providerFailures: number;
  /** 部署の端末から記録した（または記録を試みた）もの。同じものを二度記録しない */
  boardWritten: Set<string>;
}

export function simMsAt(view: SimView, now: Date): number {
  if (!view.clock.length) return 0;
  const end = view.ended ? null : now.getTime();
  let total = 0;
  for (let i = 0; i < view.clock.length; i++) {
    const seg = view.clock[i]!;
    const next = view.clock[i + 1]?.at ?? end;
    if (next === null) break;
    if (seg.running) total += (next - seg.at) * seg.speed;
  }
  return view.ended ? view.ended.simMs : Math.max(0, total);
}

export function emptySimView(): SimView {
  return {
    runId: null,
    scenarioId: null,
    provider: null,
    startedAt: null,
    clock: [],
    ended: null,
    fired: new Set(),
    observed: new Set(),
    stimuli: new Map(),
    patients: dict(),
    locations: dict(),
    transports: dict(),
    supports: dict(),
    needs: [],
    inbox: [],
    outbox: [],
    proposals: [],
    notes: dict(),
    explanations: null,
    providerFailures: 0,
    boardWritten: new Set(),
  };
}

function initLocations(scenario: Scenario, config: HospitalConfig): SimView['locations'] {
  const out: SimView['locations'] = dict();
  for (const l of config.locations) {
    const capacity = dict<number>();
    for (const c of config.capacity.filter((c) => c.locationId === l.id)) capacity[c.triage] = c.value;
    out[l.id] = { accepting: true, capacity, staff: dict() };
  }
  for (const i of scenario.initial) {
    const loc = out[i.locationId]!;
    loc.accepting = i.accepting;
    if (i.capacity) loc.capacity = Object.fromEntries(i.capacity.map((c) => [c.triage, c.value]));
    loc.staff = Object.fromEntries(i.staff.map((s) => [s.professionId, s.value]));
  }
  return out;
}

export function reduceSim(events: readonly SimEvent[], scenario: Scenario, config: HospitalConfig): SimView {
  const v = emptySimView();
  v.locations = initLocations(scenario, config);
  for (const e of events) applySim(v, e, scenario);
  return v;
}

function applySim(v: SimView, e: SimEvent, scenario: Scenario): void {
  switch (e.type) {
    case 'RunStarted':
      v.runId = e.runId;
      v.scenarioId = e.scenarioId;
      v.provider = e.provider;
      v.startedAt = e.at;
      v.clock.push({ at: Date.parse(e.at), running: true, speed: 1 });
      return;
    case 'ClockChanged':
      v.clock.push({ at: Date.parse(e.at), running: e.running, speed: e.speed });
      return;
    case 'RunEnded':
      v.ended = { simMs: e.simMs, reason: e.reason };
      return;
    case 'ScenarioEventFired': {
      v.fired.add(e.index);
      const t = scenario.timeline[e.index]!;
      if (t.type === 'patientArrives') v.patients[t.patient.key] = { ...t.patient, locationId: t.locationId, arrivedSimMs: e.simMs };
      if (t.type === 'locationStatus') {
        const loc = v.locations[t.locationId]!;
        if (t.accepting !== undefined) loc.accepting = t.accepting;
        for (const c of t.capacity ?? []) loc.capacity[c.triage] = c.value;
        if (t.note) loc.note = t.note;
      }
      if (t.type === 'supportNeed') v.needs.push({ locationId: t.locationId, kindId: t.kindId, items: t.items, note: t.note, requested: false });
      return;
    }
    case 'BoardObserved':
      v.observed.add(e.boardEventId);
      return;
    case 'StimulusQueued':
      v.stimuli.set(e.stimulusId, { role: e.role, stimulus: e.stimulus, dueSimMs: e.dueSimMs, dispatched: false, resolved: false });
      return;
    case 'TransportObserved':
      v.transports[e.transport.id] = { ...e.transport };
      return;
    case 'TransportOrderedInSim':
      v.transports[e.transportId]!.orderedSimMs = e.simMs;
      return;
    case 'TransportRedirectedInSim': {
      const t = v.transports[e.transportId]!;
      t.toLocationId = e.toLocationId;
      t.roleAccepted = null;
      return;
    }
    case 'TransportDecisionObserved': {
      const t = v.transports[e.transportId];
      if (t) t.roleAccepted = e.accepted;
      return;
    }
    case 'TransportCancelledInSim':
      v.transports[e.transportId]!.cancelled = true;
      return;
    case 'SupportObserved':
      v.supports[e.supportId] = { id: e.supportId, fromLocationId: e.fromLocationId, requestedSimMs: e.simMs };
      return;
    case 'SupportDispatchedInSim':
      v.supports[e.supportId]!.dispatchedSimMs = e.simMs;
      return;
    case 'StimulusDispatched': {
      const s = v.stimuli.get(e.stimulusId);
      if (s) s.dispatched = true;
      return;
    }
    case 'ProposalResolved': {
      v.proposals.push(e);
      const s = v.stimuli.get(e.stimulusId);
      if (s) s.resolved = true;
      if (!e.accepted || !e.proposal) return;
      const p = e.proposal;
      if (e.messageId) v.inbox.push({ messageId: e.messageId, from: e.role, text: p.message, simMs: e.simMs, heard: false, action: p.action });
      if (p.action === 'accept_transport') v.transports[p.transportId]!.roleAccepted = true;
      if (p.action === 'decline_transport') v.transports[p.transportId]!.roleAccepted = false;
      if (p.action === 'report_departure') v.transports[p.transportId]!.departedSimMs = e.simMs;
      if (p.action === 'request_support') {
        const need = v.needs.find((n) => n.locationId === e.role && !n.requested);
        if (need) need.requested = true;
      }
      return;
    }
    case 'MessageFromHQ':
      v.outbox.push({ messageId: e.messageId, to: e.to, text: e.text, simMs: e.simMs });
      return;
    case 'MessageHeard': {
      const m = v.inbox.find((x) => x.messageId === e.messageId);
      if (m) m.heard = true;
      return;
    }
    case 'TransportArrivedInSim': {
      const t = v.transports[e.transportId]!;
      t.arrivedSimMs = e.simMs;
      if (t.patientKey && v.patients[t.patientKey]) v.patients[t.patientKey]!.locationId = t.toLocationId;
      return;
    }
    case 'SupportDeliveredInSim':
      v.supports[e.supportId]!.deliveredSimMs = e.simMs;
      return;
    case 'ProviderFailed':
      v.providerFailures += 1;
      return;
    case 'ReviewNoteAdded':
      v.notes[e.findingId] = e.note;
      return;
    case 'ReviewExplained':
      v.explanations = e;
      return;
    case 'BoardWritten': {
      v.boardWritten.add(e.key);
      // 部署役の判断を記録できなかったら（受け入れ枠の超過の警告など）、シミュレーターでも判断がなかったことにする（ボードと食い違わない）
      if (!e.ok && e.decisionFor && v.transports[e.decisionFor]) v.transports[e.decisionFor]!.roleAccepted = null;
      // ボードの受け入れ可能数を超えるため、了承の代わりに断りとして記録した
      if (e.ok && e.declinedInstead && e.decisionFor && v.transports[e.decisionFor]) v.transports[e.decisionFor]!.roleAccepted = false;
      const t = e.ok && e.timelineIndex !== undefined ? scenario.timeline[e.timelineIndex] : undefined;
      if (t?.type === 'supportNeed') {
        const need = v.needs.find((n) => n.locationId === t.locationId && !n.requested);
        if (need) need.requested = true;
      }
      return;
    }
  }
}

// ---- 部署役に渡す情報（その部署が知り得ることだけ） ----

export function patientText(config: HospitalConfig, p: { tagNumber?: string; triage: string | null; sex?: string; estimatedAge?: string; features?: string }): string {
  const t = config.triageCategories.find((c) => c.id === p.triage);
  const sex = p.sex === 'male' ? '男性' : p.sex === 'female' ? '女性' : '';
  return [p.tagNumber ? `タッグ${p.tagNumber}` : 'タッグ番号なし', t ? `${t.label}` : '区分未判定', sex, p.estimatedAge, p.features].filter(Boolean).join('、');
}

/**
 * 参加者が書いた文（本部からの連絡、ボードの特徴メモなど）を、部署役への指示と区別できるよう囲む。
 * 囲みを閉じて指示を書き足されないよう、山かっこは取り除く（プロンプト・インジェクション対策）
 */
export function quoteParticipant(text: string): string {
  return `<参加者の文>${text.replace(/[<>＜＞]/g, '')}</参加者の文>`;
}

export function describeStimulus(config: HospitalConfig, s: Stimulus): string {
  const loc = (id: string) => config.locations.find((l) => l.id === id)?.name ?? id;
  const items = (xs: SupportItem[]) =>
    xs
      .map((it) =>
        it.professionId
          ? `${config.professions.find((p) => p.id === it.professionId)?.name ?? it.professionId}${it.quantity ?? ''}人`
          : it.resourceId
            ? `${config.resources.find((r) => r.id === it.resourceId)?.name ?? it.resourceId}${it.quantity ?? ''}`
            : (it.text ?? ''),
      )
      .join('、');
  switch (s.kind) {
    case 'patientArrived':
      return `あなたの部署に患者が運ばれてきた（${patientText(config, s.patient)}）。本部へ報告する。`;
    case 'statusChanged':
      return `あなたの部署の状況が変わった：${[s.accepting !== undefined && (s.accepting ? '受け入れ可' : '受け入れ不可'), ...(s.capacity ?? []).map((c) => `${config.triageCategories.find((t) => t.id === c.triage)?.label ?? c.triage}の受け入れ可能 ${c.value}人`), s.note].filter(Boolean).join('、')}。本部へ報告する。`;
    case 'needSupport':
      return `あなたの部署で支援が必要になった：${items(s.items)}${s.note ? `（${s.note}）` : ''}。本部へ要請する。`;
    case 'notice':
      return `本部に知らせるべきことがある：${s.text}`;
    case 'transportRequest':
      return `本部から、この部署の端末に搬送の受け入れ依頼が来た（${s.transportId}：${loc(s.fromLocationId)}から、${quoteParticipant(s.patientText)}）。受け入れられるか判断する。判断は、この部署の端末から記録される。`;
    case 'transportOrdered':
      return `本部から搬送の指示が来た（${s.transportId}：${quoteParticipant(s.patientText)}を${loc(s.toLocationId)}へ）。患者を送り出したら出発を報告する。`;
    case 'patientArrivedByTransport':
      return `運んでいた患者が到着先に着いた（${s.transportId}：${loc(s.fromLocationId)}から、${quoteParticipant(s.patientText)}）。本部へ無線で到着を伝える。`;
    case 'supportArrived':
      return `要請した支援が届いた（${s.supportId}：${s.itemsText}）。本部へ伝える。`;
    case 'supportFollowUp':
      return `あなたの部署が出した支援要請（${s.supportId}：${s.itemsText}${s.note ? `。理由：${s.note}` : ''}）が、${s.waitedMinutes}分たっても手配されていない（本部の担当は${s.assigned ? '付いている' : 'まだ付いていない'}）。部署の端末から本部のボードに、短く催促の連絡を残す。何に困っているかを具体的に伝え、人数や物品は要請の中身だけを使う。`;
    case 'supportArranged':
      return `本部が、あなたの部署の支援要請の手配を記録した（${s.supportId}：${s.itemsText}、${s.providerText}）。部署の端末から本部のボードに、確認したことを短く返事する。`;
    case 'hqMessage':
      return `本部から無線で連絡が来た：${quoteParticipant(s.text)}。返事をする。`;
  }
}

export interface RoleContext {
  /** department：部署（端末で記録する）／ transporter：搬送要員（無線で本部とやりとりする） */
  roleKind: 'department' | 'transporter';
  locationId: string;
  locationName: string;
  roleName: string;
  persona: string;
  /** 自部署の実際の状況（この部署が知っていること） */
  ownStatus: {
    accepting: boolean;
    /** value は受け入れ枠の合計、present はいまこの部署にいるその区分の患者数（残り＝value−present） */
    capacity: { triage: string; label: string; value: number; present: number }[];
    staff: { profession: string; value: number }[];
    patients: string[];
    note?: string;
  };
  /** この部署に関係する搬送 */
  transports: { id: string; direction: 'incoming' | 'outgoing'; otherLocation: string; status: string }[];
  /** 本部とのやりとり（新しいものが後） */
  conversation: { from: 'hq' | 'me'; text: string }[];
  stimulusId: string;
  stimulus: Stimulus;
  stimulusText: string;
  /** この場面で出してよい行動（AI にはこのツールだけを渡す） */
  allowedActions: Proposal['action'][];
  /** 選べる区分の id（報告に使う） */
  triageIds: string[];
}

export function buildRoleContext(view: SimView, scenario: Scenario, config: HospitalConfig, stimulusId: string): RoleContext {
  const st = view.stimuli.get(stimulusId)!;
  if (st.role === TRANSPORTER_ROLE) return transporterContext(view, scenario, config, stimulusId);
  const role = scenario.roles.find((r) => r.locationId === st.role)!;
  const loc = view.locations[role.locationId]!;
  const name = (id: string) => config.locations.find((l) => l.id === id)?.name ?? id;
  const inTransit = new Set(Object.values(view.transports).filter((t) => t.departedSimMs !== undefined && t.arrivedSimMs === undefined).map((t) => t.patientKey));
  const conversation = [
    ...view.inbox.filter((m) => m.from === role.locationId).map((m) => ({ from: 'me' as const, text: m.text, simMs: m.simMs })),
    ...view.outbox.filter((m) => m.to === role.locationId).map((m) => ({ from: 'hq' as const, text: m.text, simMs: m.simMs })),
  ]
    .sort((a, b) => a.simMs - b.simMs)
    .slice(-10)
    .map(({ from, text }) => ({ from, text }));
  return {
    roleKind: 'department',
    locationId: role.locationId,
    locationName: name(role.locationId),
    roleName: role.name,
    persona: role.persona,
    ownStatus: {
      accepting: loc.accepting,
      capacity: Object.entries(loc.capacity).map(([triage, value]) => ({
        triage,
        label: config.triageCategories.find((t) => t.id === triage)?.label ?? triage,
        value,
        present: Object.values(view.patients).filter((p) => p.locationId === role.locationId && p.triage === triage && !inTransit.has(p.key)).length,
      })),
      staff: Object.entries(loc.staff).map(([p, value]) => ({ profession: config.professions.find((x) => x.id === p)?.name ?? p, value })),
      patients: Object.values(view.patients)
        .filter((p) => p.locationId === role.locationId && !inTransit.has(p.key))
        .map((p) => patientText(config, p)),
      note: loc.note,
    },
    transports: Object.values(view.transports)
      .filter((t) => !t.cancelled && (t.toLocationId === role.locationId || t.fromLocationId === role.locationId))
      .map((t) => ({
        id: t.id,
        direction: t.toLocationId === role.locationId ? ('incoming' as const) : ('outgoing' as const),
        otherLocation: name(t.toLocationId === role.locationId ? t.fromLocationId : t.toLocationId),
        status: t.arrivedSimMs !== undefined ? '到着済み' : t.departedSimMs !== undefined ? '移動中' : t.roleAccepted === true ? '了承済み' : t.roleAccepted === false ? '断った' : '依頼あり',
      })),
    conversation,
    stimulusId,
    stimulus: st.stimulus,
    stimulusText: describeStimulus(config, st.stimulus),
    allowedActions: allowedActionsFor(st.role, st.stimulus),
    triageIds: config.triageCategories.map((t) => t.id),
  };
}

/** 搬送要員の役に渡す情報：いま動いている搬送と、本部との無線のやりとり */
function transporterContext(view: SimView, scenario: Scenario, config: HospitalConfig, stimulusId: string): RoleContext {
  const st = view.stimuli.get(stimulusId)!;
  const name = (id: string) => config.locations.find((l) => l.id === id)?.name ?? id;
  const t = scenario.transporter!;
  const conversation = [
    ...view.inbox.filter((m) => m.from === TRANSPORTER_ROLE).map((m) => ({ from: 'me' as const, text: m.text, simMs: m.simMs })),
    ...view.outbox.filter((m) => m.to === TRANSPORTER_ROLE).map((m) => ({ from: 'hq' as const, text: m.text, simMs: m.simMs })),
  ]
    .sort((a, b) => a.simMs - b.simMs)
    .slice(-10)
    .map(({ from, text }) => ({ from, text }));
  return {
    roleKind: 'transporter',
    locationId: TRANSPORTER_ROLE,
    locationName: '搬送要員',
    roleName: t.name,
    persona: t.persona,
    ownStatus: { accepting: true, capacity: [], staff: [], patients: [] },
    transports: Object.values(view.transports)
      .filter((x) => !x.cancelled && x.arrivedSimMs === undefined)
      .map((x) => ({
        id: x.id,
        direction: 'outgoing' as const,
        otherLocation: `${name(x.fromLocationId)}から${name(x.toLocationId)}へ`,
        status: x.departedSimMs !== undefined ? '運んでいる途中' : x.roleAccepted === true ? '受け入れ了承済み・出発前' : x.roleAccepted === false ? '受け入れを断られた' : '受け入れの返事待ち',
      })),
    conversation,
    stimulusId,
    stimulus: st.stimulus,
    stimulusText: describeStimulus(config, st.stimulus),
    allowedActions: allowedActionsFor(st.role, st.stimulus),
    triageIds: config.triageCategories.map((x) => x.id),
  };
}

// ---- 進行（時間・シナリオの出来事・ボードの観察） ----

export interface AdvanceInput {
  scenario: Scenario;
  config: HospitalConfig;
  simEvents: readonly SimEvent[];
  boardEvents: readonly DomainEvent[];
  now: Date;
}

/** 進めた結果。追記するシミュレーターの記録と、部署役に渡す刺激 */
export interface AdvanceResult {
  events: SimEventInput[];
  dispatch: string[];
}

function seqId(prefix: string, n: number) {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

/** ボードの患者を、シナリオの実際の患者に結び付ける（タッグ番号と場所で探す） */
function matchPatient(view: SimView, board: AppState, boardPatientId: string, fromLocationId: string): string | null {
  const bp = board.patients[boardPatientId];
  if (!bp) return null;
  const tag = normalizeIdentifier(bp.tagNumber);
  const used = new Set(Object.values(view.transports).filter((t) => !t.cancelled && t.arrivedSimMs === undefined).map((t) => t.patientKey));
  const candidates = Object.values(view.patients).filter((p) => tag && normalizeIdentifier(p.tagNumber) === tag);
  // 同じタッグ番号が複数あるときは、出発元にいて、区分が同じで、まだ搬送されていない患者を優先する
  const score = (p: TruthPatient) => Number(p.locationId === fromLocationId) * 4 + Number(p.triage === bp.triage) * 2 + Number(!used.has(p.key));
  return [...candidates].sort((a, b) => score(b) - score(a))[0]?.key ?? null;
}

export function advance(input: AdvanceInput): AdvanceResult {
  const { scenario, config, now } = input;
  const view = reduceSim(input.simEvents, scenario, config);
  const out: SimEventInput[] = [];
  const dispatch: string[] = [];
  if (!view.runId || view.ended) return { events: out, dispatch };

  const sim = simMsAt(view, now);
  const roles = new Set([...scenario.roles.map((r) => r.locationId), ...(scenario.transporter ? [TRANSPORTER_ROLE] : [])]);
  let stimulusCount = view.stimuli.size;
  const push = (e: SimEventInput) => {
    out.push(e);
    applySim(view, { ...e, id: '', at: now.toISOString() } as SimEvent, scenario);
  };
  const queue = (role: string, stimulus: Stimulus) => {
    if (!roles.has(role)) return; // 部署役のいない場所には知らせない（本部が無線で確認する必要がある）
    push({ type: 'StimulusQueued', stimulusId: seqId('S', ++stimulusCount), role, stimulus, dueSimMs: sim + scenario.settings.responseDelaySeconds * 1000 });
  };

  // 1. シナリオの出来事。患者の登録・受け入れ状況・支援要請は、部署の端末から記録する（pendingBoardWrites）。
  //    無線で伝えるのは、搬送要員からの知らせだけ
  scenario.timeline.forEach((t, index) => {
    if (view.fired.has(index) || t.at > sim) return;
    push({ type: 'ScenarioEventFired', index, simMs: t.at });
    if (t.type === 'notice' && t.reporter === TRANSPORTER_ROLE) queue(TRANSPORTER_ROLE, { kind: 'notice', text: t.text });
  });

  // 2. 参加者のボードの記録を見る（ボードは変えない）
  const board = reduce(input.boardEvents);
  for (const e of input.boardEvents) {
    if (view.observed.has(e.id)) continue;
    push({ type: 'BoardObserved', boardEventId: e.id, simMs: sim });
    const bt = e.subject.kind === 'transport' ? board.transports[e.subject.id] : undefined;
    const text = bt ? patientText(config, board.patients[bt.patientId] ?? { triage: null }) : '';
    if (e.type === 'TransportRequested') {
      push({
        type: 'TransportObserved',
        transport: {
          id: e.subject.id,
          boardPatientId: e.payload.patientId,
          patientKey: matchPatient(view, board, e.payload.patientId, e.payload.fromLocationId),
          fromLocationId: e.payload.fromLocationId,
          toLocationId: e.payload.toLocationId,
          roleAccepted: null,
          cancelled: false,
        },
      });
      queue(e.payload.toLocationId, { kind: 'transportRequest', transportId: e.subject.id, patientText: text, fromLocationId: e.payload.fromLocationId });
    }
    const tt = view.transports[e.subject.id];
    // 搬送の指示は、本部が無線で搬送要員に伝える（ボードの記録だけでは搬送要員は動かない）
    if (e.type === 'TransportOrdered' && tt && tt.departedSimMs === undefined) push({ type: 'TransportOrderedInSim', transportId: tt.id, simMs: sim });
    if (e.type === 'TransportRedirected' && tt) {
      push({ type: 'TransportRedirectedInSim', transportId: tt.id, toLocationId: e.payload.toLocationId });
      if (tt.departedSimMs === undefined) queue(e.payload.toLocationId, { kind: 'transportRequest', transportId: tt.id, patientText: text, fromLocationId: tt.fromLocationId });
    }
    if (e.type === 'TransportCancelled' && tt) push({ type: 'TransportCancelledInSim', transportId: tt.id });
    // ボードの受け入れの了承・断り（参加者が手で記録したもの、部署役のいない行き先など）も、実際の状態に反映する
    if ((e.type === 'TransportAccepted' || e.type === 'TransportDeclined') && tt && tt.roleAccepted !== (e.type === 'TransportAccepted'))
      push({ type: 'TransportDecisionObserved', transportId: tt.id, accepted: e.type === 'TransportAccepted' });
    if (e.type === 'SupportRequested') push({ type: 'SupportObserved', supportId: e.subject.id, fromLocationId: e.payload.fromLocationId, simMs: sim });
    const ts = view.supports[e.subject.id];
    if (e.type === 'SupportDispatched' && ts && ts.dispatchedSimMs === undefined) {
      push({ type: 'SupportDispatchedInSim', supportId: e.subject.id, simMs: sim });
      // 要請した部署（部署役のいる部署）は、手配の記録を見て端末から返事をする
      const bs = board.supports[e.subject.id];
      const provider = e.payload.providerLocationId ? config.locations.find((l) => l.id === e.payload.providerLocationId)?.name : e.payload.providerName;
      if (bs) queue(ts.fromLocationId, { kind: 'supportArranged', supportId: bs.id, itemsText: describeItems(config, e.payload.items?.length ? e.payload.items : bs.items), providerText: provider ? `${provider}から` : '送り元は未記録' });
    }
  }

  // 3. 予定された事実（到着・支援の到着）
  for (const t of Object.values(view.transports)) {
    if (t.cancelled || t.departedSimMs === undefined || t.arrivedSimMs !== undefined) continue;
    const due = t.departedSimMs + scenario.settings.travelMinutes * 60000;
    if (due > sim) continue;
    push({ type: 'TransportArrivedInSim', transportId: t.id, simMs: due });
    const bt = board.transports[t.id];
    // 到着は到着先の端末から記録する（pendingBoardWrites）。搬送要員は無線で本部に到着を伝える
    queue(TRANSPORTER_ROLE, {
      kind: 'patientArrivedByTransport',
      transportId: t.id,
      patientText: bt ? patientText(config, board.patients[bt.patientId] ?? { triage: null }) : '',
      fromLocationId: t.fromLocationId,
    });
  }
  for (const s of Object.values(view.supports)) {
    if (s.dispatchedSimMs === undefined || s.deliveredSimMs !== undefined) continue;
    const due = s.dispatchedSimMs + scenario.settings.supportDeliveryMinutes * 60000;
    if (due > sim) continue;
    // 受け取りは要請した部署の端末から記録する（pendingBoardWrites）
    push({ type: 'SupportDeliveredInSim', supportId: s.id, simMs: due });
  }

  // 3b. 手配されないままの支援要請：要請した部署役が、端末から本部に催促する（1件の要請に1回だけ）
  const followedUp = new Set([...view.stimuli.values()].flatMap((x) => (x.stimulus.kind === 'supportFollowUp' ? [x.stimulus.supportId] : [])));
  for (const s of Object.values(view.supports)) {
    if (s.requestedSimMs === undefined || s.dispatchedSimMs !== undefined || followedUp.has(s.id)) continue;
    const bs = board.supports[s.id];
    if (!bs || bs.retracted || bs.closed || bs.steps.dispatched) continue;
    const waited = sim - s.requestedSimMs;
    if (waited < scenario.settings.supportFollowUpMinutes * 60000) continue;
    queue(s.fromLocationId, { kind: 'supportFollowUp', supportId: s.id, itemsText: describeItems(config, bs.items), note: bs.note, assigned: !!bs.steps.assigned, waitedMinutes: Math.max(1, Math.round(waited / 60000)) });
  }

  // 4. 返事の時間が来た刺激を部署役に渡す
  for (const [stimulusId, st] of view.stimuli) {
    if (st.dispatched || st.dueSimMs > sim) continue;
    push({ type: 'StimulusDispatched', stimulusId, simMs: sim });
    dispatch.push(stimulusId);
  }

  // 5. 時間切れ
  if (sim >= scenario.durationMinutes * 60000) push({ type: 'RunEnded', simMs: scenario.durationMinutes * 60000, reason: 'time' });

  return { events: out, dispatch };
}

function describeItems(config: HospitalConfig, items: SupportItem[]): string {
  return items
    .map((it) =>
      it.professionId
        ? `${config.professions.find((p) => p.id === it.professionId)?.name ?? it.professionId} ${it.quantity ?? '?'}人`
        : it.resourceId
          ? `${config.resources.find((r) => r.id === it.resourceId)?.name ?? it.resourceId} ${it.quantity ?? '?'}`
          : (it.text ?? ''),
    )
    .join('、');
}

// ---- 提案の検証と反映 ----

/** 刺激ごとに、部署役が出してよい行動。これ以外の行動は却下する（関係のない返事で状態を動かさない） */
export const allowedActions: Record<Stimulus['kind'], Proposal['action'][]> = {
  patientArrived: ['reply_message', 'report_status'],
  statusChanged: ['report_status', 'reply_message'],
  needSupport: ['request_support', 'reply_message'],
  notice: ['reply_message'],
  // 部署の受け入れの判断は、了承か断りのどちらか（判断は部署の端末から記録する）
  transportRequest: ['accept_transport', 'decline_transport'],
  transportOrdered: ['report_departure', 'reply_message'],
  patientArrivedByTransport: ['report_arrival', 'reply_message'],
  supportArrived: ['reply_message'],
  // 支援要請の催促と、手配への返事は、部署の端末から本部のボードに残す連絡（決まった形の連絡だけ）
  supportFollowUp: ['reply_message'],
  supportArranged: ['reply_message'],
  // 本部からの無線（搬送要員への指示など）
  hqMessage: ['reply_message', 'report_departure'],
};

/** 役と場面ごとに、出してよい行動 */
export function allowedActionsFor(role: string, stimulus: Stimulus): Proposal['action'][] {
  return allowedActions[stimulus.kind];
}

/**
 * 医療的な判断（診断・トリアージ判定・治療の助言）を含む言葉。部署役の返事に含まれていたら却下する。
 * プロンプトでの指示に加えた、出力側の簡単な確認
 */
// 単語だけでは止めない（「輸液セット」の要請や「点滴中の入院患者」のような、ふつうの連絡を止めないため）。
// 指示・判断・見立ての言い方だけを止める
const MEDICAL_ADVICE = new RegExp(
  [
    // 診断・病名の見立て
    '診断(する|し|を|は|が|の結果)', '疑い(が|の)?(ある|あり|濃厚)',
    // 治療・処置の指示や勧め
    '(処方|投与|投薬|輸液|輸血|点滴|止血|酸素|治療|手術|処置)(を|は)?(すぐ(に)?)?(して|し|始めて|開始して|行って|おこなって|実施して|優先して|投与して)(ください|ほしい|下さい)',
    '(処方|投与|投薬|輸液|輸血|点滴|止血|治療|手術|処置)(を|は)?(すべき|が必要|した(方|ほう)がよい|した(方|ほう)がいい)',
    // 区分（トリアージ）の判断
    '(トリアージ|区分)を[^。、]{0,6}(変更|変え|上げ|下げ)', '(トリアージ|区分)(は|が)[^。]{0,6}(妥当|適切)', '(赤|黄|緑|黒)(に|へ)(上げ|下げ)', '(赤|黄|緑|黒)(に|へ)(変え|変更)(る|す|し)?(べき|た(方|ほう)が|てください)', '(赤|黄|緑|黒)が(妥当|適切)',
    '(赤|黄|緑|黒)(色)?(に|へ)(す|し)(べき|た(方|ほう)が)', '(赤|黄|緑|黒)(色)?の(方|ほう)が((良|よ)(い|さ)|いい)',
    // 薬の量と投与の経路・処置の指示（「アドレナリン0.3mgを筋注で」のような言い方。物品の要請の「500ml」だけでは止めない）
    '\\d+(\\.\\d+)?(mg|μg|mcg|ml|l)(を|で)?(筋注|静注|皮下注|投与|内服|点滴|iv|im)', '\\d+(l|リットル)(/分)?(リザーバー|マスク|カニューラ)',
    '(筋注|静注|皮下注|点滴静注|挿管|除細動|ルート確保)(で|を|して|し|する|します|開始)',
    '(止血帯|ターニケット)を(巻|使|つけ)', '圧迫を(続け|して|し)', '手術適応', '(酸素|輸液|点滴|投与|処置)を開始',
    // 英語の言い方
    '\\b(diagnos\\w*|administer|inject\\w*|intubat\\w*|start (an )?iv|iv fluids?|triage (him|her|them|the patient|should|to))\\b',
  ].join('|'),
  'i',
);

/**
 * AI が書いた文に、医療的な判断を含む言葉があるか（部署役の返事・断りの理由・振り返りの説明文に使う）。
 * 病院設定の物品・場所・職種の名前（「輸液セット」「処置室」など）は、確かめる前に取り除く
 */
export function containsMedicalAdvice(text: string, config?: HospitalConfig): boolean {
  let t = text;
  if (config) {
    const names = [...config.resources.map((r) => r.name), ...config.locations.map((l) => l.name), ...config.professions.map((p) => p.name)];
    for (const n of names.sort((x, y) => y.length - x.length)) t = t.split(n).join('□');
  }
  // 全角・半角の違いと空白で抜けないよう、そろえてから確かめる（「診 断」「０．３ｍｇ」など）
  const n = t.normalize('NFKC');
  return MEDICAL_ADVICE.test(n) || MEDICAL_ADVICE.test(n.replace(/\s+/g, ''));
}

export function validateProposal(view: SimView, config: HospitalConfig, role: string, p: Proposal, stimulus?: Stimulus): string | null {
  if (stimulus && !allowedActionsFor(role, stimulus).includes(p.action)) return `この連絡への返事として「${p.action}」はできない`;
  if (role === TRANSPORTER_ROLE) return validateTransporterProposal(view, config, p);
  const loc = view.locations[role];
  if (!loc) return '部署が見つからない';
  if (containsMedicalAdvice(p.message, config)) return '医療的な判断を含む言葉がある';
  // 断りの理由など、返事以外の文も同じように確かめる
  if ('reason' in p && typeof p.reason === 'string' && containsMedicalAdvice(p.reason, config)) return '理由に医療的な判断を含む言葉がある';
  const t = 'transportId' in p ? view.transports[p.transportId] : undefined;
  switch (p.action) {
    case 'reply_message': {
      if (stimulus?.kind !== 'supportFollowUp' && stimulus?.kind !== 'supportArranged') return null;
      const sup = view.supports[stimulus.supportId];
      if (!sup || sup.fromLocationId !== role) return 'この部署の支援要請ではない';
      if (stimulus.kind === 'supportFollowUp' && sup.dispatchedSimMs !== undefined) return 'すでに手配されている（催促は要らない）';
      // 言葉の中の人数・数量は、要請の中身にある数だけ（数字を作り出さない）
      const known = new Set([...stimulus.itemsText.normalize('NFKC').matchAll(/\d+/g)].map((m) => m[0]));
      const said = [...p.message.normalize('NFKC').matchAll(/(\d+)\s*(人|名|本|台|個|枚|セット|箱)/g)].map((m) => m[1]!);
      if (said.some((n) => !known.has(n))) return '言葉の中の数が要請の中身と違う';
      return null;
    }
    case 'report_status': {
      if (p.accepting === null && p.capacity.length === 0) return '報告する状況がない（返事だけなら reply_message）';
      if (p.accepting !== null && p.accepting !== loc.accepting) return '受け入れ可否が実際の状態と違う';
      for (const c of p.capacity) {
        if (!(c.triage in loc.capacity)) return `区分「${c.triage}」の受け入れ枠はこの部署にない`;
        if (loc.capacity[c.triage] !== c.value) return '受け入れ可能人数が実際の状態と違う';
      }
      // 言葉の中の人数（「N人」）も、報告した人数と合っていなければならない（構造化した値と文の食い違いを防ぐ）
      // 場所の名前（3階東病棟など）の数字は人数ではないので見ない
      const numbers = [...p.message.normalize('NFKC').matchAll(/(\d+)\s*人/g)].map((m) => Number(m[1]));
      const allowed = new Set(p.capacity.map((c) => c.value));
      if (numbers.some((n) => !allowed.has(n))) return '言葉の中の数字が報告した人数と違う';
      return null;
    }
    case 'accept_transport': {
      if (!t || t.cancelled) return `搬送「${p.transportId}」の依頼はこの部署に来ていない`;
      if (t.toLocationId !== role) return 'この部署への搬送ではない';
      if (t.arrivedSimMs !== undefined || t.departedSimMs !== undefined) return 'すでに出発・到着している';
      if (t.roleAccepted === true) return 'すでに了承している';
      if (!loc.accepting) return 'この部署はいま受け入れ不可';
      // どの患者か分からないと、受け入れ枠で判断できない（本部にタッグ番号や特徴を確かめてもらう）
      if (!t.patientKey) return 'どの患者か特定できない';
      const triage = view.patients[t.patientKey]?.triage;
      if (!triage || !(triage in loc.capacity)) return 'この区分の患者の受け入れ枠がない';
      const present = Object.values(view.patients).filter((x) => x.locationId === role && x.triage === triage).length;
      const incoming = Object.values(view.transports).filter(
        (x) => x.id !== t.id && x.toLocationId === role && x.roleAccepted === true && x.arrivedSimMs === undefined && !x.cancelled && x.patientKey && view.patients[x.patientKey]?.triage === triage,
      ).length;
      if (loc.capacity[triage]! - present - incoming <= 0) return '受け入れ可能人数を超える';
      return null;
    }
    case 'decline_transport':
      if (!t || t.cancelled) return `搬送「${p.transportId}」の依頼はこの部署に来ていない`;
      if (t.toLocationId !== role) return 'この部署への搬送ではない';
      if (t.departedSimMs !== undefined) return 'すでに出発している';
      if (t.roleAccepted === false) return 'すでに断っている';
      return null;
    case 'report_departure':
      if (!t || t.cancelled) return `搬送「${p.transportId}」が見つからない`;
      if (t.fromLocationId !== role) return 'この部署から出る搬送ではない';
      // 出発は本部の指示を受けてから
      if (t.orderedSimMs === undefined) return '本部の搬送の指示がまだない';
      if (t.departedSimMs !== undefined) return 'すでに出発している';
      if (!t.patientKey || view.patients[t.patientKey]?.locationId !== role) return 'その患者はこの部署にいない';
      return null;
    case 'report_arrival':
      if (!t) return `搬送「${p.transportId}」が見つからない`;
      if (t.toLocationId !== role) return 'この部署への搬送ではない';
      if (t.arrivedSimMs === undefined) return 'まだ到着していない';
      return null;
    case 'request_support':
      return view.needs.some((n) => n.locationId === role && !n.requested) ? null : 'この部署にいま必要な支援はない';
  }
}

/** 搬送要員の役の提案：無線の返事、出発・到着の連絡 */
function validateTransporterProposal(view: SimView, config: HospitalConfig, p: Proposal): string | null {
  if (containsMedicalAdvice(p.message, config)) return '医療的な判断を含む言葉がある';
  const t = 'transportId' in p ? view.transports[p.transportId] : undefined;
  switch (p.action) {
    case 'reply_message':
      return null;
    case 'report_departure':
      if (!t || t.cancelled) return `搬送「${p.transportId}」が見つからない`;
      if (t.departedSimMs !== undefined) return 'すでに出発している';
      if (t.roleAccepted === false) return '到着先が受け入れを断っている';
      // 到着先の了承がないまま運び出さない（搬送要員は本部に確かめる）
      if (t.roleAccepted !== true) return '到着先の受け入れの了承がまだない';
      if (!t.patientKey || view.patients[t.patientKey]?.locationId !== t.fromLocationId) return 'その患者は出発元にいない';
      return null;
    case 'report_arrival':
      if (!t) return `搬送「${p.transportId}」が見つからない`;
      if (t.arrivedSimMs === undefined) return 'まだ到着していない';
      return null;
    default:
      return `搬送要員は「${p.action}」はできない`;
  }
}

/** 部署役の提案を検証して記録にする。形が正しくない提案（null）も却下として残す */
export function resolveProposals(
  simEvents: readonly SimEvent[],
  scenario: Scenario,
  config: HospitalConfig,
  stimulusId: string,
  proposals: (Proposal | null)[],
  now: Date,
): SimEventInput[] {
  const view = reduceSim(simEvents, scenario, config);
  const st = view.stimuli.get(stimulusId);
  // 終わった回への返事は受け付けない（振り返りに、終了後の返事が混ざらないように）
  if (!st || st.resolved || view.ended) return [];
  const sim = simMsAt(view, now);
  const out: SimEventInput[] = [];
  let messages = view.inbox.length;
  if (proposals.length === 0) proposals = [null];
  for (const p of proposals) {
    const reason = p ? validateProposal(view, config, st.role, p, st.stimulus) : '提案の形が正しくない';
    const e: SimEventInput = reason
      ? { type: 'ProposalResolved', stimulusId, role: st.role, proposal: p, accepted: false, reason, simMs: sim }
      : // 無線で本部に届くのは搬送要員の言葉だけ。部署の判断は端末の記録として届く（pendingBoardWrites）
        { type: 'ProposalResolved', stimulusId, role: st.role, proposal: p, accepted: true, ...(st.role === TRANSPORTER_ROLE ? { messageId: seqId('R', ++messages) } : {}), simMs: sim };
    out.push(e);
    applySim(view, { ...e, id: '', at: now.toISOString() } as SimEvent, scenario);
  }
  return out;
}
