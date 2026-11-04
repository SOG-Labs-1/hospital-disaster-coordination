import type { HospitalConfig } from './config';
import type { DomainEvent } from './events';
import type { CheckRule, Scenario } from './scenario';
import type { SimView } from './simulator';
import { activePatients, normalizeIdentifier, reduce, type AppState, type PatientView } from './state';

// 訓練の振り返り（純粋な関数）。照合はプログラムで行い、AI は説明文を書く役に限る。
// 点数や順位は付けない。「記録がない（起きたがボードにない）」と「実施されなかった」を区別する。

/** 設計書 §10.2 の5つの観点 */
export const findingCategories = {
  unshared: '情報が確認・共有されなかった',
  unassigned: '要請に担当が付かなかった',
  unconfirmed: '指示の受領や実行が確認できなかった',
  'broken-handoff': '受け入れや引き渡しの調整が途切れた',
  'undefined-role': '担当や手順がそもそも決まっていなかった',
} as const;
export type FindingCategory = keyof typeof findingCategories;

export interface Finding {
  id: string;
  category: FindingCategory;
  /** no-record：実際には起きた・伝えられたが、ボードに記録がない。not-done：実際にも行われていない */
  kind: 'no-record' | 'not-done';
  title: string;
  detail: string;
  /** 根拠（ボードの番号 P-/T-/S-、部署役からの連絡 R-、本部からの連絡 H-） */
  evidence: string[];
}

export interface CheckResult {
  id: string;
  text: string;
  source: 'scenario' | 'hospital';
  /** met：満たした、no-record：起きたが記録がない、not-met：満たしていない、self-check：参加者が自分で確かめる項目 */
  result: 'met' | 'no-record' | 'not-met' | 'self-check';
  evidence: string[];
}

export interface Review {
  findings: Finding[];
  checks: CheckResult[];
  /** 実際の患者とボードの患者の対応（シナリオの key → 管理番号） */
  matches: Record<string, string | null>;
}

const minutes = (ms: number) => Math.round(ms / 60000);

/**
 * 実際の患者を、ボードの患者に結び付ける。タッグ番号が同じなら区分・特徴・場所の近いものを選ぶ。
 * 1人のボードの患者は1人の実際の患者にしか結び付けない
 */
export function matchPatients(view: SimView, board: AppState): Record<string, string | null> {
  const used = new Set<string>();
  const out: Record<string, string | null> = {};
  const truth = Object.values(view.patients).sort((a, b) => a.arrivedSimMs - b.arrivedSimMs);
  const boardPatients = activePatients(board);
  for (const t of truth) {
    const tag = normalizeIdentifier(t.tagNumber);
    const score = (p: PatientView) =>
      (tag && normalizeIdentifier(p.tagNumber) === tag ? 8 : 0) +
      (p.triage === t.triage ? 2 : 0) +
      (t.features && p.features && t.features.split(/[、,\s]+/).some((w) => w && p.features!.includes(w)) ? 3 : 0) +
      (p.sex === t.sex && t.sex !== 'unknown' ? 1 : 0);
    const best = boardPatients.filter((p) => !used.has(p.id)).sort((a, b) => score(b) - score(a))[0];
    // タッグ番号か特徴が合わなければ、同じ患者とはみなさない
    if (best && score(best) >= 3) {
      out[t.key] = best.id;
      used.add(best.id);
    } else out[t.key] = null;
  }
  return out;
}

export function buildReview(input: { scenario: Scenario; config: HospitalConfig; view: SimView; boardEvents: readonly DomainEvent[] }): Review {
  const { scenario, config, view, boardEvents } = input;
  const board = reduce(boardEvents);
  const matches = matchPatients(view, board);
  const findings: Finding[] = [];
  const loc = (id: string) => config.locations.find((l) => l.id === id)?.name ?? id;
  const tri = (id: string | null) => config.triageCategories.find((t) => t.id === id)?.label ?? '未判定';
  const add = (f: Omit<Finding, 'id'>) => findings.push({ ...f, id: `F-${String(findings.length + 1).padStart(2, '0')}` });
  const truthText = (key: string) => {
    const p = view.patients[key]!;
    return [p.tagNumber ? `タッグ${p.tagNumber}` : 'タッグなし', tri(p.triage), p.features].filter(Boolean).join('・');
  };
  /** その刺激に対する部署役の連絡（R-番号） */
  const messagesFor = (pred: (stimulus: SimView['stimuli'] extends Map<string, infer V> ? V : never) => boolean) =>
    view.proposals.filter((p) => p.accepted && p.messageId && pred(view.stimuli.get(p.stimulusId)!)).map((p) => p.messageId!);
  const boardTransports = board.transportOrder.map((id) => board.transports[id]!).filter((t) => !t.retracted);

  // 1. 情報が確認・共有されなかった
  for (const [key, boardId] of Object.entries(matches)) {
    const p = view.patients[key]!;
    const reported = messagesFor((s) => s.stimulus.kind === 'patientArrived' && s.stimulus.patient.key === key);
    if (!boardId) {
      add({
        category: 'unshared',
        kind: reported.length ? 'no-record' : 'not-done',
        title: `患者（${truthText(key)}）がボードに登録されていない`,
        detail: reported.length
          ? `${loc(p.locationId)}から無線で報告があったが、ボードに患者の記録がない。`
          : `${loc(p.locationId)}にいるが、本部に報告が届いていない。`,
        evidence: reported,
      });
      continue;
    }
    const bp = board.patients[boardId]!;
    const moving = view.transports && Object.values(view.transports).some((t) => t.patientKey === key && t.departedSimMs !== undefined && t.arrivedSimMs === undefined);
    if (!moving && bp.locationId !== p.locationId) {
      add({
        category: 'unshared',
        kind: 'no-record',
        title: `${boardId} の所在がボードと実際で違う`,
        detail: `ボードでは${loc(bp.locationId)}、実際には${loc(p.locationId)}にいる。`,
        evidence: [boardId],
      });
    }
  }
  // 同じタッグ番号の患者がボードで1人にまとまっている
  const tagCounts = new Map<string, string[]>();
  for (const p of Object.values(view.patients)) if (p.tagNumber) tagCounts.set(normalizeIdentifier(p.tagNumber), [...(tagCounts.get(normalizeIdentifier(p.tagNumber)) ?? []), p.key]);
  for (const [tag, keys] of tagCounts) {
    if (keys.length < 2) continue;
    const onBoard = activePatients(board).filter((p) => normalizeIdentifier(p.tagNumber) === tag);
    if (onBoard.length < keys.length && onBoard.length > 0)
      add({
        category: 'unshared',
        kind: 'no-record',
        title: `タッグ番号${tag}の患者が実際は${keys.length}人いるが、ボードには${onBoard.length}人`,
        detail: '手書きのタッグ番号が重なっている。特徴メモで見分けて、別の患者として登録する必要がある。',
        evidence: onBoard.map((p) => p.id),
      });
  }
  // 場所の状況の変化
  scenario.timeline.forEach((t, i) => {
    if (t.type !== 'locationStatus' || !view.fired.has(i)) return;
    const reported = messagesFor((s) => s.role === t.locationId && s.stimulus.kind === 'statusChanged');
    const recorded = boardEvents.some((e) => e.type === 'LocationStatusReported' && e.subject.id === t.locationId);
    if (!recorded)
      add({
        category: 'unshared',
        kind: reported.length ? 'no-record' : 'not-done',
        title: `${loc(t.locationId)}の受け入れ状況がボードに記録されていない`,
        detail: reported.length ? '無線で状況の報告があったが、院内の状況に記録がない。' : '状況が変わったが、本部に伝わっていない。',
        evidence: reported,
      });
  });
  // 聞いた印のない連絡
  const unheard = view.inbox.filter((m) => !m.heard);
  if (unheard.length)
    add({
      category: 'unshared',
      kind: 'no-record',
      title: `「聞いた」の印のない連絡が${unheard.length}件ある`,
      detail: '受け取ったかどうかが記録で分からない。',
      evidence: unheard.map((m) => m.messageId),
    });

  // 2. 要請に担当が付かなかった
  for (const need of view.needs) {
    if (!need.requested) continue;
    const reported = messagesFor((s) => s.role === need.locationId && s.stimulus.kind === 'needSupport');
    const onBoard = Object.values(board.supports).filter((s) => !s.retracted && s.fromLocationId === need.locationId);
    if (onBoard.length === 0) {
      add({ category: 'unassigned', kind: 'no-record', title: `${loc(need.locationId)}からの支援要請がボードにない`, detail: '無線で要請があったが、支援要請として記録されていない。', evidence: reported });
      continue;
    }
    for (const s of onBoard)
      if (!s.steps.assigned)
        add({ category: 'unassigned', kind: 'not-done', title: `${s.id}（${loc(s.fromLocationId)}）に担当が付いていない`, detail: '受付（担当）の記録がない。', evidence: [s.id] });
  }

  // 3. 指示の受領や実行が確認できなかった ／ 4. 受け入れや引き渡しの調整が途切れた ／ 5. 手順
  const optional = new Set(config.transportPolicy.optionalSteps);
  for (const bt of boardTransports) {
    const tt = view.transports[bt.id];
    if (bt.steps.cancelled) continue;
    if (bt.steps.ordered && !bt.steps.acknowledged)
      add({ category: 'unconfirmed', kind: 'no-record', title: `${bt.id} の指示の受領確認がない`, detail: '指示を出したが、相手が受け取ったかを確かめた記録がない。', evidence: [bt.id] });
    if (tt?.departedSimMs !== undefined && !bt.steps.departed) {
      const r = view.proposals.filter((p) => p.accepted && p.proposal?.action === 'report_departure' && 'transportId' in p.proposal && p.proposal.transportId === bt.id).map((p) => p.messageId!);
      add({ category: 'unconfirmed', kind: 'no-record', title: `${bt.id} の出発がボードに記録されていない`, detail: `実際には${minutes(tt.departedSimMs)}分ごろに出発している。`, evidence: [bt.id, ...r] });
    }
    if (tt?.arrivedSimMs !== undefined && !bt.steps.arrived) {
      const r = view.proposals.filter((p) => p.accepted && p.proposal?.action === 'report_arrival' && 'transportId' in p.proposal && p.proposal.transportId === bt.id).map((p) => p.messageId!);
      add({ category: 'unconfirmed', kind: 'no-record', title: `${bt.id} の到着がボードに記録されていない`, detail: `実際には${minutes(tt.arrivedSimMs)}分ごろに${loc(tt.toLocationId)}に着いている。`, evidence: [bt.id, ...r] });
    }
    if (!bt.steps.accepted && !bt.steps.declined) {
      const r = view.proposals.filter((p) => p.accepted && (p.proposal?.action === 'accept_transport' || p.proposal?.action === 'decline_transport') && 'transportId' in p.proposal! && p.proposal.transportId === bt.id).map((p) => p.messageId!);
      if (r.length || bt.steps.departed || bt.steps.arrived)
        add({
          category: 'broken-handoff',
          kind: r.length ? 'no-record' : 'not-done',
          title: `${bt.id} の受け入れ了承が記録されていない`,
          detail: r.length ? `${loc(bt.toLocationId)}から返事があったが、ボードに了承・断りの記録がない。` : `了承を確かめないまま${bt.steps.arrived ? '到着' : '出発'}している。`,
          evidence: [bt.id, ...r],
        });
    }
    if (tt?.roleAccepted === false && (bt.steps.departed || bt.steps.ordered) && !bt.steps.declined)
      add({ category: 'broken-handoff', kind: 'not-done', title: `${bt.id} は受け入れを断られたまま進んでいる`, detail: `${loc(bt.toLocationId)}は受け入れを断っている。行き先の変更が必要だった。`, evidence: [bt.id] });
    if (bt.steps.arrived && !bt.steps.arrived.handover && !bt.steps.handedOver)
      add({ category: 'broken-handoff', kind: 'no-record', title: `${bt.id} の引き渡しが記録されていない`, detail: '到着後、担当部署が移ったかが記録で分からない。', evidence: [bt.id] });
    if (!optional.has('staffAssigned') && !bt.steps.staffAssigned && (bt.steps.departed || bt.steps.arrived))
      add({ category: 'undefined-role', kind: 'no-record', title: `${bt.id} の搬送要員が記録されていない`, detail: '誰が運んだかが分からない。', evidence: [bt.id] });
  }
  for (const s of Object.values(board.supports))
    if (!s.retracted && s.steps.assigned && !s.steps.dispatched && !s.steps.received && !s.closed)
      add({ category: 'undefined-role', kind: 'not-done', title: `${s.id} は担当が付いたが手配先が決まっていない`, detail: '誰が、どこから応援を出すのかが決まっていない。', evidence: [s.id] });

  // 確認項目
  const checks: CheckResult[] = [
    ...scenario.checks.map((c) => ({ id: c.id, text: c.text, source: 'scenario' as const, ...evaluate(c.rule, view, board, matches) })),
    ...config.checklist.map((c) => ({ id: `hospital-${c.id}`, text: c.text, source: 'hospital' as const, result: 'self-check' as const, evidence: [] })),
  ];
  return { findings, checks, matches };
}

function evaluate(rule: CheckRule, view: SimView, board: AppState, matches: Record<string, string | null>): Pick<CheckResult, 'result' | 'evidence'> {
  const transportsOf = (key: string) => {
    const id = matches[key];
    return id ? board.transportOrder.map((t) => board.transports[t]!).filter((t) => !t.retracted && t.patientId === id) : [];
  };
  switch (rule.type) {
    case 'patientRegistered': {
      const id = matches[rule.patientKey];
      return id ? { result: 'met', evidence: [id] } : { result: view.patients[rule.patientKey] ? 'no-record' : 'not-met', evidence: [] };
    }
    case 'patientAt': {
      const id = matches[rule.patientKey];
      if (id && board.patients[id]!.locationId === rule.locationId) return { result: 'met', evidence: [id] };
      return { result: view.patients[rule.patientKey]?.locationId === rule.locationId ? 'no-record' : 'not-met', evidence: id ? [id] : [] };
    }
    case 'transportArrived': {
      const ts = transportsOf(rule.patientKey).filter((t) => t.toLocationId === rule.toLocationId);
      const done = ts.find((t) => t.steps.arrived);
      if (done) return { result: 'met', evidence: [done.id] };
      const truthArrived = Object.values(view.transports).some((t) => t.patientKey === rule.patientKey && t.toLocationId === rule.toLocationId && t.arrivedSimMs !== undefined);
      return { result: truthArrived ? 'no-record' : 'not-met', evidence: ts.map((t) => t.id) };
    }
    case 'transportAcknowledged': {
      const ts = transportsOf(rule.patientKey);
      const ok = ts.find((t) => t.steps.acknowledged);
      return ok ? { result: 'met', evidence: [ok.id] } : { result: 'not-met', evidence: ts.map((t) => t.id) };
    }
    case 'supportAssigned': {
      const ss = Object.values(board.supports).filter((s) => !s.retracted && s.fromLocationId === rule.fromLocationId);
      const ok = ss.find((s) => s.steps.assigned && Date.parse(s.steps.assigned.observedAt) - Date.parse(s.steps.requested.observedAt) <= rule.withinMinutes * 60000);
      return ok ? { result: 'met', evidence: [ok.id] } : { result: ss.length ? 'not-met' : view.needs.some((n) => n.locationId === rule.fromLocationId && n.requested) ? 'no-record' : 'not-met', evidence: ss.map((s) => s.id) };
    }
    case 'supportCompleted': {
      const ss = Object.values(board.supports).filter((s) => !s.retracted && s.fromLocationId === rule.fromLocationId);
      const ok = ss.find((s) => s.steps.completed);
      return ok ? { result: 'met', evidence: [ok.id] } : { result: 'not-met', evidence: ss.map((s) => s.id) };
    }
    case 'locationStatusRecorded': {
      const ok = board.locations[rule.locationId]?.lastObservedAt;
      return ok ? { result: 'met', evidence: [] } : { result: 'not-met', evidence: [] };
    }
    case 'duplicateTagHandled': {
      const tag = normalizeIdentifier(rule.tagNumber);
      const ps = activePatients(board).filter((p) => normalizeIdentifier(p.tagNumber) === tag);
      return ps.length >= 2 ? { result: 'met', evidence: ps.map((p) => p.id) } : { result: 'not-met', evidence: ps.map((p) => p.id) };
    }
  }
}
