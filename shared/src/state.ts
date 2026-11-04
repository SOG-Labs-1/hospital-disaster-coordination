import {
  payloadSchemas,
  type Decider,
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

/** 確認時刻つきの報告値。value が null なら「未確認」 */
export interface Reported<T> {
  value: T | null;
  confirmedAt: string | null;
  eventId: string | null;
}

export type TransportStatus = 'requested' | 'accepted' | 'declined' | 'staff-assigned' | 'ordered' | 'acknowledged' | 'in-transit' | 'arrived' | 'cancelled';

export interface StepRecord {
  eventId: string;
  observedAt: string;
  recordedAt: string;
  enteredBy: string;
}

export interface TransportView {
  id: string;
  patientId: string;
  fromLocationId: string;
  /** いまの行き先（行き先変更を反映） */
  toLocationId: string;
  methodId?: string;
  escorts: { professionId: string; count: number }[];
  note?: string;
  transporterIds: string[];
  teamId?: string;
  /** 段階ごとの最新の記録。未記録なら undefined */
  steps: {
    requested: StepRecord;
    accepted?: StepRecord & { decidedBy: Decider; note?: string };
    declined?: StepRecord & { decidedBy: Decider; reason: string };
    staffAssigned?: StepRecord;
    ordered?: StepRecord & { orderedBy: Decider; note?: string };
    acknowledged?: StepRecord;
    departed?: StepRecord;
    arrived?: StepRecord & { note?: string; handover: boolean };
    handedOver?: StepRecord;
    cancelled?: StepRecord & { reason: string };
  };
  redirects: { fromLocationId: string; toLocationId: string; reason: string; eventId: string; observedAt: string }[];
  status: TransportStatus;
  /** 到着・中止・断りで終わった */
  closed: boolean;
  overrides: { eventId: string; codes: string[]; reason: string }[];
  retracted: boolean;
  lastObservedAt: string;
}

export interface TransporterActivity {
  available: boolean;
  availabilityNote?: string;
  availabilitySince?: string;
  /** 最後の到着先 */
  lastLocationId?: string;
}

export interface LocationView {
  accepting: Reported<boolean>;
  capacity: Record<string, Reported<number>>;
  staff: Record<string, Reported<number>>;
  note?: string;
  lastObservedAt: string | null;
}

export interface AppState {
  patients: Record<string, PatientView>;
  transports: Record<string, TransportView>;
  transportOrder: string[];
  requestedTransportCount: number;
  transporters: Record<string, TransporterActivity>;
  locations: Record<string, LocationView>;
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
    transports: {},
    transportOrder: [],
    requestedTransportCount: 0,
    transporters: {},
    locations: {},
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

export function formatTransportId(n: number): string {
  return `T-${String(n).padStart(3, '0')}`;
}

/** 識別番号の比較用。全角・半角や前後の空白、大文字小文字の違いをそろえる */
export function normalizeIdentifier(value: string | undefined | null): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

type Correction = { eventId: string; reason: string; retract: boolean; replacement?: Record<string, unknown> };

/** 訂正を反映した中身を返す。取り消しなら null */
export function effectivePayload<T extends EventType>(
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

  if (e.subject.kind === 'transport') return applyTransportEvent(state, e, correction);
  if (e.subject.kind === 'transporter') return applyTransporterEvent(state, e, correction);
  if (e.subject.kind === 'location') return applyLocationEvent(state, e, correction);

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

// ---- 搬送 ----

function step(e: DomainEvent): StepRecord {
  return { eventId: e.id, observedAt: e.observedAt, recordedAt: e.recordedAt, enteredBy: e.enteredBy };
}

/** 段階の記録から状態を決める。事実（到着・出発）を調整より優先する */
function transportStatus(t: TransportView): TransportStatus {
  const s = t.steps;
  if (s.cancelled) return 'cancelled';
  if (s.arrived) return 'arrived';
  if (s.departed) return 'in-transit';
  if (s.declined) return 'declined';
  if (s.acknowledged) return 'acknowledged';
  if (s.ordered) return 'ordered';
  if (s.staffAssigned) return 'staff-assigned';
  if (s.accepted) return 'accepted';
  return 'requested';
}

function applyTransportEvent(state: AppState, e: DomainEvent, correction: Correction | undefined): void {
  if (e.type === 'TransportRequested') {
    state.requestedTransportCount += 1;
    const p = effectivePayload(e, correction) ?? e.payload;
    const t: TransportView = {
      id: e.subject.id,
      patientId: p.patientId,
      fromLocationId: p.fromLocationId,
      toLocationId: p.toLocationId,
      methodId: p.methodId,
      escorts: p.escorts,
      note: p.note || undefined,
      transporterIds: [],
      steps: { requested: step(e) },
      redirects: [],
      status: 'requested',
      closed: false,
      overrides: [],
      retracted: correction?.retract ?? false,
      lastObservedAt: e.observedAt,
    };
    if (e.override) t.overrides.push({ eventId: e.id, codes: e.override.codes, reason: e.override.reason });
    state.transports[t.id] = t;
    state.transportOrder.push(t.id);
    return;
  }

  const t = state.transports[e.subject.id];
  if (!t) return;
  if (laterObservation(e, { observedAt: t.lastObservedAt })) t.lastObservedAt = e.observedAt;
  if (e.override) t.overrides.push({ eventId: e.id, codes: e.override.codes, reason: e.override.reason });

  switch (e.type) {
    case 'TransportAccepted': {
      const p = effectivePayload(e, correction);
      if (p) {
        t.steps.accepted = { ...step(e), decidedBy: p.decidedBy, note: p.note };
        delete t.steps.declined;
      }
      break;
    }
    case 'TransportDeclined': {
      const p = effectivePayload(e, correction);
      if (p) {
        t.steps.declined = { ...step(e), decidedBy: p.decidedBy, reason: p.reason };
        delete t.steps.accepted;
      }
      break;
    }
    case 'TransportStaffAssigned': {
      const p = effectivePayload(e, correction);
      if (p) {
        t.transporterIds = [...p.transporterIds];
        t.teamId = p.teamId;
        t.steps.staffAssigned = step(e);
      }
      break;
    }
    case 'TransportOrdered': {
      const p = effectivePayload(e, correction);
      if (p) t.steps.ordered = { ...step(e), orderedBy: p.orderedBy, note: p.note };
      break;
    }
    case 'TransportAcknowledged': {
      if (effectivePayload(e, correction)) t.steps.acknowledged = step(e);
      break;
    }
    case 'TransportCancelled': {
      const p = effectivePayload(e, correction);
      if (p) t.steps.cancelled = { ...step(e), reason: p.reason };
      break;
    }
    case 'TransportRedirected': {
      const p = effectivePayload(e, correction);
      if (p) {
        t.redirects.push({ fromLocationId: t.toLocationId, toLocationId: p.toLocationId, reason: p.reason, eventId: e.id, observedAt: e.observedAt });
        t.toLocationId = p.toLocationId;
        // 行き先が変わったら、受け入れの了承・断りは新しい行き先について取り直す
        delete t.steps.accepted;
        delete t.steps.declined;
      }
      break;
    }
    case 'TransportDeparted': {
      if (effectivePayload(e, correction)) t.steps.departed = step(e);
      break;
    }
    case 'TransportArrived': {
      const p = effectivePayload(e, correction);
      if (!p) break;
      t.steps.arrived = { ...step(e), note: p.note, handover: p.handover };
      const patient = state.patients[t.patientId];
      if (patient) {
        patient.locationId = t.toLocationId;
        patient.locationSince = e.observedAt;
        if (p.handover) patient.departmentLocationId = t.toLocationId;
        if (laterObservation(e, { observedAt: patient.lastObservedAt })) patient.lastObservedAt = e.observedAt;
        patient.lastRecordedAt = e.recordedAt;
      }
      // 到着した搬送要員は、最後の到着先で待機に戻る（対応不可のまま割り当てられていた場合も待機に戻す）
      for (const id of t.transporterIds) {
        const a = (state.transporters[id] ??= { available: true });
        a.lastLocationId = t.toLocationId;
        if (!a.available) {
          a.available = true;
          a.availabilityNote = undefined;
          a.availabilitySince = e.observedAt;
        }
      }
      break;
    }
    case 'TransportHandedOver': {
      if (!effectivePayload(e, correction)) break;
      t.steps.handedOver = step(e);
      const patient = state.patients[t.patientId];
      if (patient) patient.departmentLocationId = t.toLocationId;
      break;
    }
  }
  t.status = transportStatus(t);
  t.closed = t.status === 'arrived' || t.status === 'cancelled' || t.status === 'declined';
}

function applyTransporterEvent(state: AppState, e: DomainEvent, correction: Correction | undefined): void {
  if (e.type !== 'TransporterAvailabilityChanged') return;
  const p = effectivePayload(e, correction);
  if (!p) return;
  const a = (state.transporters[e.subject.id] ??= { available: true });
  a.available = p.available;
  a.availabilityNote = p.note || undefined;
  a.availabilitySince = e.observedAt;
}

function unconfirmed<T>(): Reported<T> {
  return { value: null, confirmedAt: null, eventId: null };
}

export function locationView(state: AppState, locationId: string): LocationView {
  return state.locations[locationId] ?? { accepting: unconfirmed(), capacity: {}, staff: {}, lastObservedAt: null };
}

function applyLocationEvent(state: AppState, e: DomainEvent, correction: Correction | undefined): void {
  const loc = (state.locations[e.subject.id] ??= { accepting: unconfirmed(), capacity: {}, staff: {}, lastObservedAt: null });
  const reported = <T>(value: T | null): Reported<T> => ({ value, confirmedAt: e.observedAt, eventId: e.id });
  // 後から入力された古い確認では、新しい確認を上書きしない
  const newer = (r: Reported<unknown> | undefined) => !r?.confirmedAt || laterObservation(e, { observedAt: r.confirmedAt });

  if (e.type === 'LocationStatusReported') {
    const p = effectivePayload(e, correction);
    if (!p) return;
    if (p.accepting !== undefined && newer(loc.accepting)) loc.accepting = reported(p.accepting);
    for (const c of p.capacity) if (newer(loc.capacity[c.triage])) loc.capacity[c.triage] = reported(c.value);
    if (p.note !== undefined) loc.note = p.note || undefined;
  } else if (e.type === 'StaffCountReported') {
    const p = effectivePayload(e, correction);
    if (!p) return;
    for (const c of p.counts) if (newer(loc.staff[c.professionId])) loc.staff[c.professionId] = reported(c.value);
  } else return;
  if (!loc.lastObservedAt || laterObservation(e, { observedAt: loc.lastObservedAt })) loc.lastObservedAt = e.observedAt;
}

// ---- 集計のための問い合わせ ----

export function activeTransports(state: AppState): TransportView[] {
  return state.transportOrder.map((id) => state.transports[id]!).filter((t) => !t.retracted && !t.closed);
}

export function activeTransportsForPatient(state: AppState, patientId: string, excludeId?: string): TransportView[] {
  return activeTransports(state).filter((t) => t.patientId === patientId && t.id !== excludeId);
}

export type TransporterStatus = 'idle' | 'assigned' | 'moving' | 'unavailable';

export function transporterStatus(state: AppState, transporterId: string): { status: TransporterStatus; transportId?: string; lastLocationId?: string } {
  const a = state.transporters[transporterId];
  const busy = activeTransports(state).find((t) => t.transporterIds.includes(transporterId));
  if (busy) return { status: busy.steps.departed ? 'moving' : 'assigned', transportId: busy.id, lastLocationId: a?.lastLocationId };
  if (a && !a.available) return { status: 'unavailable', lastLocationId: a.lastLocationId };
  return { status: 'idle', lastLocationId: a?.lastLocationId };
}

/** その場所にいま居る患者（搬送中で出発済みの患者は含めない） */
export function patientsAtLocation(state: AppState, locationId: string): PatientView[] {
  const departed = new Set(activeTransports(state).filter((t) => t.steps.departed).map((t) => t.patientId));
  return activePatients(state).filter((p) => p.locationId === locationId && !departed.has(p.id));
}

/** その場所へ向かっている（了承済みまたは出発済みで、まだ到着していない）搬送 */
export function incomingTransports(state: AppState, locationId: string): TransportView[] {
  return activeTransports(state).filter((t) => t.toLocationId === locationId && (t.steps.accepted || t.steps.departed));
}

/** 付き添いで場所を離れている人数（出発済み・未到着の搬送の付き添い） */
export function escortsAway(state: AppState, locationId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of activeTransports(state)) {
    if (t.fromLocationId !== locationId || !t.steps.departed) continue;
    for (const e of t.escorts) out[e.professionId] = (out[e.professionId] ?? 0) + e.count;
  }
  return out;
}
