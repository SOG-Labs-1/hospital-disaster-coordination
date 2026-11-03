import {
  payloadSchemas,
  subjectKey,
  type DomainEvent,
  type EventType,
  type PayloadOf,
  type Reporter,
  type Subject,
} from './events';

// イベントの並びから画面の状態を集計する（reducer）。状態は常にイベントから作り直せる。

export type EntryStatus = 'valid' | 'corrected' | 'retracted';

export interface TriageHistoryEntry {
  eventId: string;
  triage: string | null;
  observedAt: string;
  recordedAt: string;
  enteredBy: string;
  reportedBy: Reporter | null;
  status: EntryStatus;
  /** 訂正された場合の元の値 */
  originalTriage?: string | null;
  correctionReason?: string;
}

export interface PatientView {
  id: string;
  registeredEventId: string;
  registeredAt: string;
  tagNumber?: string;
  hospitalPatientId?: string;
  medicalId?: string;
  name?: string;
  sex: 'male' | 'female' | 'unknown';
  estimatedAge?: string;
  features?: string;
  conditionNote?: string;
  freeNote?: string;
  triage: string | null;
  triageObservedAt: string;
  triageHistory: TriageHistoryEntry[];
  locationId: string;
  locationSince: string;
  departmentLocationId: string;
  /** この患者について最後に現場で確認された時刻 */
  lastObservedAt: string;
  lastRecordedAt: string;
  overrides: { eventId: string; codes: string[]; reason: string }[];
  /** 登録そのものが訂正で取り消された */
  retracted: boolean;
}

export interface EventMeta {
  type: EventType;
  subject: Subject;
  payload: unknown;
}

export interface AppState {
  patients: Record<string, PatientView>;
  /** 登録順 */
  patientOrder: string[];
  /** 対象ごとの版番号＝その対象のイベント件数 */
  versions: Record<string, number>;
  /** 発行済みの患者管理番号の数（取り消し分も含む） */
  registeredCount: number;
  eventMeta: Record<string, EventMeta>;
  eventCount: number;
  lastEventId: string | null;
  lastRecordedAt: string | null;
}

export function emptyState(): AppState {
  return {
    patients: {},
    patientOrder: [],
    versions: {},
    registeredCount: 0,
    eventMeta: {},
    eventCount: 0,
    lastEventId: null,
    lastRecordedAt: null,
  };
}

export function versionOf(state: AppState, subject: Subject): number {
  return state.versions[subjectKey(subject)] ?? 0;
}

export function formatPatientId(n: number): string {
  return `P-${String(n).padStart(3, '0')}`;
}

/** 識別番号の比較用。全角・半角や前後の空白、大文字小文字の違いをそろえる */
export function normalizeIdentifier(value: string | undefined | null): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

type Correction = { eventId: string; reason: string; retract: boolean; replacement?: Record<string, unknown> };

/** 訂正を反映した中身を返す。取り消しなら null */
function effectivePayload<T extends EventType>(
  event: DomainEvent & { type: T },
  correction: Correction | undefined,
): PayloadOf<T> | null {
  if (!correction) return event.payload as PayloadOf<T>;
  if (correction.retract) return null;
  const merged = { ...(event.payload as object), ...(correction.replacement ?? {}) };
  const r = payloadSchemas[event.type].safeParse(merged);
  // 検証済みの訂正しか記録されないが、念のため読めない場合は元の中身を使う
  return (r.success ? r.data : event.payload) as PayloadOf<T>;
}

function laterObservation(a: { observedAt: string }, b: { observedAt: string }): boolean {
  return Date.parse(a.observedAt) >= Date.parse(b.observedAt);
}

export function reduce(events: readonly DomainEvent[]): AppState {
  // 訂正は後から追記されるので、先に「どのイベントがどう訂正されたか」を集める（同じ対象への訂正は最後のものが有効）
  const corrections = new Map<string, Correction>();
  for (const e of events) {
    if (e.type === 'EventCorrected' && e.corrects) {
      corrections.set(e.corrects, { eventId: e.id, ...e.payload });
    }
  }

  const state = emptyState();
  for (const e of events) applyEvent(state, e, corrections.get(e.id));
  return state;
}

function applyEvent(state: AppState, e: DomainEvent, correction: Correction | undefined): void {
  const key = subjectKey(e.subject);
  state.versions[key] = (state.versions[key] ?? 0) + 1;
  state.eventMeta[e.id] = { type: e.type, subject: e.subject, payload: e.payload };
  state.eventCount += 1;
  state.lastEventId = e.id;
  state.lastRecordedAt = e.recordedAt;

  if (e.type === 'PatientRegistered') {
    state.registeredCount += 1;
    const p = effectivePayload(e, correction) ?? e.payload;
    const patient: PatientView = {
      id: e.subject.id,
      registeredEventId: e.id,
      registeredAt: e.recordedAt,
      tagNumber: p.tagNumber || undefined,
      hospitalPatientId: p.hospitalPatientId || undefined,
      medicalId: p.medicalId || undefined,
      name: p.name || undefined,
      sex: p.sex,
      estimatedAge: p.estimatedAge || undefined,
      features: p.features || undefined,
      conditionNote: p.conditionNote || undefined,
      freeNote: p.freeNote || undefined,
      triage: p.triage,
      triageObservedAt: e.observedAt,
      triageHistory: [
        {
          eventId: e.id,
          triage: p.triage,
          observedAt: e.observedAt,
          recordedAt: e.recordedAt,
          enteredBy: e.enteredBy,
          reportedBy: e.reportedBy,
          status: correction ? (correction.retract ? 'retracted' : 'corrected') : 'valid',
          ...(correction ? { originalTriage: e.payload.triage, correctionReason: correction.reason } : {}),
        },
      ],
      locationId: p.locationId,
      locationSince: e.observedAt,
      departmentLocationId: p.departmentLocationId ?? p.locationId,
      lastObservedAt: e.observedAt,
      lastRecordedAt: e.recordedAt,
      overrides: [],
      retracted: correction?.retract ?? false,
    };
    if (e.override) patient.overrides.push({ eventId: e.id, codes: e.override.codes, reason: e.override.reason });
    state.patients[patient.id] = patient;
    state.patientOrder.push(patient.id);
    return;
  }

  if (e.type === 'EventCorrected') {
    // 訂正の中身は reduce の最初に集めて、対象イベントの反映時に使う。ここでは対象の更新時刻だけ進める
    const target = e.subject.kind === 'patient' ? state.patients[e.subject.id] : undefined;
    if (target) target.lastRecordedAt = e.recordedAt;
    return;
  }

  const patient = state.patients[e.subject.id];
  if (!patient) return;
  patient.lastRecordedAt = e.recordedAt;
  if (laterObservation(e, { observedAt: patient.lastObservedAt })) patient.lastObservedAt = e.observedAt;
  if (e.override) patient.overrides.push({ eventId: e.id, codes: e.override.codes, reason: e.override.reason });

  switch (e.type) {
    case 'PatientIdentifierAdded': {
      const p = effectivePayload(e, correction);
      if (p) patient[p.kind] = p.value;
      return;
    }
    case 'PatientNoteUpdated': {
      const p = effectivePayload(e, correction);
      if (p) patient[p.field] = p.value || undefined;
      return;
    }
    case 'PatientTriageChanged': {
      const p = effectivePayload(e, correction);
      patient.triageHistory.push({
        eventId: e.id,
        triage: p ? p.triage : e.payload.triage,
        observedAt: e.observedAt,
        recordedAt: e.recordedAt,
        enteredBy: e.enteredBy,
        reportedBy: e.reportedBy,
        status: correction ? (correction.retract ? 'retracted' : 'corrected') : 'valid',
        ...(correction ? { originalTriage: e.payload.triage, correctionReason: correction.reason } : {}),
      });
      // 現在の区分は「現場で最後に確認された」ものにする。後から入力された古い確認で上書きしない
      if (p && laterObservation(e, { observedAt: patient.triageObservedAt })) {
        patient.triage = p.triage;
        patient.triageObservedAt = e.observedAt;
      } else if (!p) {
        recomputeTriage(patient);
      }
      return;
    }
  }
}

function recomputeTriage(patient: PatientView): void {
  let best: TriageHistoryEntry | undefined;
  for (const h of patient.triageHistory) {
    if (h.status === 'retracted') continue;
    if (!best || laterObservation(h, best)) best = h;
  }
  if (best) {
    patient.triage = best.triage;
    patient.triageObservedAt = best.observedAt;
  }
}

export function activePatients(state: AppState): PatientView[] {
  return state.patientOrder.map((id) => state.patients[id]!).filter((p) => !p.retracted);
}

/** 識別番号が一致する（取り消されていない）患者 */
export function findPatientsByIdentifier(
  state: AppState,
  kind: 'tagNumber' | 'hospitalPatientId',
  value: string | undefined,
  excludeId?: string,
): PatientView[] {
  const v = normalizeIdentifier(value);
  if (!v) return [];
  return activePatients(state).filter((p) => p.id !== excludeId && normalizeIdentifier(p[kind]) === v);
}
