import type { HospitalConfig } from './config';
import type { DomainEvent, SupportItem } from './events';
import type { Proposal } from './proposals';
import type { Scenario, ScenarioPatient } from './scenario';
import { normalizeIdentifier, reduce, type AppState } from './state';

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
  | { kind: 'hqMessage'; text: string };

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
    | { type: 'SupportObserved'; supportId: string; fromLocationId: string }
    | { type: 'SupportDispatchedInSim'; supportId: string; simMs: number }
    | { type: 'TransportArrivedInSim'; transportId: string; simMs: number }
    | { type: 'SupportDeliveredInSim'; supportId: string; simMs: number }
    | { type: 'RunEnded'; simMs: number; reason: 'time' | 'manual' }
    /** 部署役（AI）の返事に失敗し、決まった返事（mock）で補った */
    | { type: 'ProviderFailed'; stimulusId: string; error: string }
    | { type: 'ReviewNoteAdded'; findingId: string; note: string }
    | { type: 'ReviewExplained'; provider: string; explanations: { findingId: string; text: string; evidence: string[] }[] }
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
    patients: {},
    locations: {},
    transports: {},
    supports: {},
    needs: [],
    inbox: [],
    outbox: [],
    proposals: [],
    notes: {},
    explanations: null,
    providerFailures: 0,
  };
}

function initLocations(scenario: Scenario, config: HospitalConfig): SimView['locations'] {
  const out: SimView['locations'] = {};
  for (const l of config.locations) {
    const capacity: Record<string, number> = {};
    for (const c of config.capacity.filter((c) => c.locationId === l.id)) capacity[c.triage] = c.value;
    out[l.id] = { accepting: true, capacity, staff: {} };
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
    case 'TransportCancelledInSim':
      v.transports[e.transportId]!.cancelled = true;
      return;
    case 'SupportObserved':
      v.supports[e.supportId] = { id: e.supportId, fromLocationId: e.fromLocationId };
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
  }
}

// ---- 部署役に渡す情報（その部署が知り得ることだけ） ----

export function patientText(config: HospitalConfig, p: { tagNumber?: string; triage: string | null; sex?: string; estimatedAge?: string; features?: string }): string {
  const t = config.triageCategories.find((c) => c.id === p.triage);
  const sex = p.sex === 'male' ? '男性' : p.sex === 'female' ? '女性' : '';
  return [p.tagNumber ? `タッグ${p.tagNumber}` : 'タッグ番号なし', t ? `${t.label}` : '区分未判定', sex, p.estimatedAge, p.features].filter(Boolean).join('、');
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
      return `本部から搬送の受け入れ依頼が来た（${s.transportId}：${loc(s.fromLocationId)}から、${s.patientText}）。受け入れられるか判断して返事をする。`;
    case 'transportOrdered':
      return `本部から搬送の指示が来た（${s.transportId}：${s.patientText}を${loc(s.toLocationId)}へ）。患者を送り出したら出発を報告する。`;
    case 'patientArrivedByTransport':
      return `搬送されてきた患者が到着した（${s.transportId}：${loc(s.fromLocationId)}から、${s.patientText}）。本部へ到着を報告する。`;
    case 'supportArrived':
      return `要請した支援が届いた（${s.supportId}：${s.itemsText}）。本部へ伝える。`;
    case 'hqMessage':
      return `本部から連絡が来た：「${s.text}」。返事をする。`;
  }
}

export interface RoleContext {
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
    allowedActions: allowedActions[st.stimulus.kind],
    triageIds: config.triageCategories.map((t) => t.id),
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
  const roles = new Set(scenario.roles.map((r) => r.locationId));
  let stimulusCount = view.stimuli.size;
  const push = (e: SimEventInput) => {
    out.push(e);
    applySim(view, { ...e, id: '', at: now.toISOString() } as SimEvent, scenario);
  };
  const queue = (role: string, stimulus: Stimulus) => {
    if (!roles.has(role)) return; // 部署役のいない場所には知らせない（本部が無線で確認する必要がある）
    push({ type: 'StimulusQueued', stimulusId: seqId('S', ++stimulusCount), role, stimulus, dueSimMs: sim + scenario.settings.responseDelaySeconds * 1000 });
  };

  // 1. シナリオの出来事
  scenario.timeline.forEach((t, index) => {
    if (view.fired.has(index) || t.at > sim) return;
    push({ type: 'ScenarioEventFired', index, simMs: t.at });
    if (t.type === 'patientArrives') queue(t.locationId, { kind: 'patientArrived', patient: t.patient });
    if (t.type === 'locationStatus') queue(t.locationId, { kind: 'statusChanged', accepting: t.accepting, capacity: t.capacity, note: t.note });
    if (t.type === 'supportNeed') queue(t.locationId, { kind: 'needSupport', kindId: t.kindId, items: t.items, note: t.note });
    if (t.type === 'notice') queue(t.reporter, { kind: 'notice', text: t.text });
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
    if (e.type === 'TransportOrdered' && tt && tt.departedSimMs === undefined) {
      push({ type: 'TransportOrderedInSim', transportId: tt.id, simMs: sim });
      queue(tt.fromLocationId, { kind: 'transportOrdered', transportId: tt.id, patientText: text, toLocationId: tt.toLocationId });
    }
    if (e.type === 'TransportRedirected' && tt) {
      push({ type: 'TransportRedirectedInSim', transportId: tt.id, toLocationId: e.payload.toLocationId });
      if (tt.departedSimMs === undefined) queue(e.payload.toLocationId, { kind: 'transportRequest', transportId: tt.id, patientText: text, fromLocationId: tt.fromLocationId });
    }
    if (e.type === 'TransportCancelled' && tt) push({ type: 'TransportCancelledInSim', transportId: tt.id });
    if (e.type === 'SupportRequested') push({ type: 'SupportObserved', supportId: e.subject.id, fromLocationId: e.payload.fromLocationId });
    if (e.type === 'SupportDispatched' && view.supports[e.subject.id] && view.supports[e.subject.id]!.dispatchedSimMs === undefined)
      push({ type: 'SupportDispatchedInSim', supportId: e.subject.id, simMs: sim });
  }

  // 3. 予定された事実（到着・支援の到着）
  for (const t of Object.values(view.transports)) {
    if (t.cancelled || t.departedSimMs === undefined || t.arrivedSimMs !== undefined) continue;
    const due = t.departedSimMs + scenario.settings.travelMinutes * 60000;
    if (due > sim) continue;
    push({ type: 'TransportArrivedInSim', transportId: t.id, simMs: due });
    const bt = board.transports[t.id];
    queue(t.toLocationId, {
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
    push({ type: 'SupportDeliveredInSim', supportId: s.id, simMs: due });
    const bs = board.supports[s.id];
    queue(s.fromLocationId, {
      kind: 'supportArrived',
      supportId: s.id,
      itemsText: bs ? describeItems(config, bs.items) : '',
    });
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
  transportRequest: ['accept_transport', 'decline_transport', 'reply_message'],
  transportOrdered: ['report_departure', 'reply_message'],
  patientArrivedByTransport: ['report_arrival', 'reply_message'],
  supportArrived: ['reply_message'],
  hqMessage: ['reply_message', 'report_status', 'accept_transport', 'decline_transport'],
};

/**
 * 医療的な判断（診断・トリアージ判定・治療の助言）を含む言葉。部署役の返事に含まれていたら却下する。
 * プロンプトでの指示に加えた、出力側の簡単な確認
 */
const MEDICAL_ADVICE = new RegExp(
  [
    // 診断・病名の見立て
    '診断', '疑い(が|の)?(ある|あり|濃厚)', '骨折', '出血して(いる|います)',
    // 治療・処置の指示
    '処方', '投与', '投薬', '輸液', '輸血', '点滴', '止血', '酸素を', '治療(を|して|すべき|が必要)', '手術(を|して|すべき|が必要)', '処置(を|して|すべき|が必要)',
    // 区分（トリアージ）の判断
    '(トリアージ|区分)[^。]{0,8}(変更|変え|上げ|下げ|妥当|適切|すべき)', '(赤|黄|緑|黒)(に|へ)(上げ|下げ|変え|変更)', '(赤|黄|緑|黒)が(妥当|適切)',
  ].join('|'),
);

/** AI が書いた文に、医療的な判断を含む言葉があるか（部署役の返事・断りの理由・振り返りの説明文に使う） */
export function containsMedicalAdvice(text: string): boolean {
  return MEDICAL_ADVICE.test(text);
}

export function validateProposal(view: SimView, config: HospitalConfig, role: string, p: Proposal, stimulus?: Stimulus): string | null {
  const loc = view.locations[role];
  if (!loc) return '部署が見つからない';
  if (stimulus && !allowedActions[stimulus.kind].includes(p.action)) return `この連絡への返事として「${p.action}」はできない`;
  if (MEDICAL_ADVICE.test(p.message)) return '医療的な判断を含む言葉がある';
  // 断りの理由など、返事以外の文も同じように確かめる
  if ('reason' in p && typeof p.reason === 'string' && MEDICAL_ADVICE.test(p.reason)) return '理由に医療的な判断を含む言葉がある';
  const t = 'transportId' in p ? view.transports[p.transportId] : undefined;
  switch (p.action) {
    case 'reply_message':
      return null;
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
  if (!st || st.resolved) return [];
  const sim = simMsAt(view, now);
  const out: SimEventInput[] = [];
  let messages = view.inbox.length;
  if (proposals.length === 0) proposals = [null];
  for (const p of proposals) {
    const reason = p ? validateProposal(view, config, st.role, p, st.stimulus) : '提案の形が正しくない';
    const e: SimEventInput = reason
      ? { type: 'ProposalResolved', stimulusId, role: st.role, proposal: p, accepted: false, reason, simMs: sim }
      : { type: 'ProposalResolved', stimulusId, role: st.role, proposal: p, accepted: true, messageId: seqId('R', ++messages), simMs: sim };
    out.push(e);
    applySim(view, { ...e, id: '', at: now.toISOString() } as SimEvent, scenario);
  }
  return out;
}
