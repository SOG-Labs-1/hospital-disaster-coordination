import { z } from 'zod';
import type { HospitalConfig } from './config';
import {
  DeciderSchema,
  EscortSchema,
  EventCorrectedPayload,
  OverrideSchema,
  PatientIdentifierAddedPayload,
  PatientNoteUpdatedPayload,
  PatientRegisteredPayload,
  PatientTriageChangedPayload,
  ReporterSchema,
  identifierLabels,
  payloadSchemas,
  type Decider,
  type DomainEvent,
  type EventType,
  type Mode,
  type Override,
  type Subject,
} from './events';
import {
  activeTransportsForPatient,
  findPatientsByIdentifier,
  formatMessageId,
  formatPatientId,
  formatSupportId,
  formatTransportId,
  incomingTransports,
  locationView,
  patientsAtLocation,
  transporterStatus,
  versionOf,
  type AppState,
} from './state';

// コマンド（画面からの依頼）を検証し、追記するイベントを決める。
// ここは純粋な関数で、保存や配信はしない。

const optionalText = z.string().trim().optional();

export const CommandSchema = z.discriminatedUnion('type', [
  // 患者
  z.object({ type: z.literal('RegisterPatient'), payload: PatientRegisteredPayload }),
  z.object({ type: z.literal('AddPatientIdentifier'), patientId: z.string(), payload: PatientIdentifierAddedPayload }),
  z.object({ type: z.literal('ChangePatientTriage'), patientId: z.string(), payload: PatientTriageChangedPayload }),
  z.object({ type: z.literal('UpdatePatientNote'), patientId: z.string(), payload: PatientNoteUpdatedPayload }),
  z.object({ type: z.literal('CorrectPatientDetails'), patientId: z.string(), payload: payloadSchemas.PatientDetailsCorrected }),
  /** sourceId の患者を patientId の患者にまとめる */
  z.object({ type: z.literal('MergePatients'), patientId: z.string(), payload: payloadSchemas.PatientsMerged }),
  // 訂正
  z.object({ type: z.literal('CorrectEvent'), eventId: z.string(), payload: EventCorrectedPayload }),
  // 搬送（調整・指示）
  z.object({
    type: z.literal('RequestTransport'),
    payload: z.object({
      patientId: z.string().min(1),
      /** 省略時は患者のいまの所在 */
      fromLocationId: z.string().optional(),
      toLocationId: z.string().min(1),
      methodId: z.string().optional(),
      escorts: z.array(EscortSchema).default([]),
      note: optionalText,
    }),
  }),
  z.object({ type: z.literal('AcceptTransport'), transportId: z.string(), payload: z.object({ decidedBy: DeciderSchema, note: optionalText }) }),
  z.object({ type: z.literal('DeclineTransport'), transportId: z.string(), payload: z.object({ decidedBy: DeciderSchema, reason: z.string().trim().min(1) }) }),
  z.object({
    type: z.literal('AssignTransportStaff'),
    transportId: z.string(),
    payload: z.object({ transporterIds: z.array(z.string()).min(1), teamId: z.string().optional() }),
  }),
  z.object({ type: z.literal('OrderTransport'), transportId: z.string(), payload: z.object({ orderedBy: DeciderSchema, note: optionalText }) }),
  z.object({ type: z.literal('AcknowledgeTransport'), transportId: z.string(), payload: z.object({ note: optionalText }).default({}) }),
  z.object({ type: z.literal('CancelTransport'), transportId: z.string(), payload: z.object({ reason: z.string().trim().min(1) }) }),
  z.object({
    type: z.literal('RedirectTransport'),
    transportId: z.string(),
    payload: z.object({ toLocationId: z.string().min(1), reason: z.string().trim().min(1) }),
  }),
  // 搬送（事実）
  z.object({ type: z.literal('RecordDeparture'), transportId: z.string(), payload: z.object({ note: optionalText }).default({}) }),
  z.object({ type: z.literal('RecordArrival'), transportId: z.string(), payload: z.object({ note: optionalText }).default({}) }),
  z.object({ type: z.literal('RecordHandover'), transportId: z.string(), payload: z.object({ note: optionalText }).default({}) }),
  // 搬送要員
  z.object({
    type: z.literal('SetTransporterAvailability'),
    transporterId: z.string(),
    payload: z.object({ available: z.boolean(), note: optionalText }),
  }),
  // 場所
  z.object({ type: z.literal('ReportLocationStatus'), locationId: z.string(), payload: payloadSchemas.LocationStatusReported }),
  z.object({ type: z.literal('ReportStaffCount'), locationId: z.string(), payload: payloadSchemas.StaffCountReported }),
  // 支援要請
  z.object({ type: z.literal('RequestSupport'), payload: payloadSchemas.SupportRequested }),
  z.object({ type: z.literal('AssignSupport'), supportId: z.string(), payload: payloadSchemas.SupportAssigned }),
  z.object({ type: z.literal('DispatchSupport'), supportId: z.string(), payload: payloadSchemas.SupportDispatched }),
  z.object({ type: z.literal('RecordSupportReceived'), supportId: z.string(), payload: payloadSchemas.SupportReceived.default({}) }),
  z.object({ type: z.literal('CompleteSupport'), supportId: z.string(), payload: payloadSchemas.SupportCompleted.default({}) }),
  z.object({ type: z.literal('CancelSupport'), supportId: z.string(), payload: payloadSchemas.SupportCancelled }),
  // 連絡メモ
  z.object({ type: z.literal('LogMessage'), payload: payloadSchemas.MessageLogged }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandInput = z.input<typeof CommandSchema>;

export const CommandEnvelopeSchema = z.object({
  command: CommandSchema,
  meta: z.object({
    enteredBy: z.string().min(1),
    terminal: z.string().min(1),
    reportedBy: ReporterSchema.nullable().default(null),
    /** 現場で確認した時刻。省略時は記録時刻 */
    observedAt: z.iso.datetime({ offset: true }).optional(),
  }),
  /** 対象の版番号。新規の登録・要請・報告では省略できる */
  expectedVersion: z.number().int().min(0).optional(),
  override: OverrideSchema.optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type CommandEnvelopeInput = z.input<typeof CommandEnvelopeSchema>;

export const warningCodes = {
  DUPLICATE_TAG_NUMBER: 'DUPLICATE_TAG_NUMBER',
  DUPLICATE_HOSPITAL_PATIENT_ID: 'DUPLICATE_HOSPITAL_PATIENT_ID',
  DUPLICATE_ACTIVE_TRANSPORT: 'DUPLICATE_ACTIVE_TRANSPORT',
  TRANSPORTER_BUSY: 'TRANSPORTER_BUSY',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
} as const;
export type WarningCode = keyof typeof warningCodes;

export interface DomainWarning {
  code: WarningCode;
  message: string;
  relatedPatientIds: string[];
  relatedTransportIds?: string[];
}

export type DecideResult =
  | { status: 'accepted'; events: DomainEvent[] }
  | { status: 'conflict'; subject: Subject; expectedVersion: number; currentVersion: number }
  | { status: 'warnings'; warnings: DomainWarning[] }
  | { status: 'rejected'; errors: string[] };

export interface DecideContext {
  mode: Mode;
  /** サーバーの現在時刻（ISO 8601） */
  now: string;
  newId: () => string;
}

/** 現場で確認した時刻が記録時刻より先になりすぎていないか（時計のずれを見込んで5分まで許す） */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** 版番号の確認をしないコマンド（対象を新しく作る、または事実の報告を足すだけのもの） */
const versionFree = new Set<Command['type']>(['RegisterPatient', 'RequestTransport', 'RequestSupport', 'ReportLocationStatus', 'ReportStaffCount', 'LogMessage']);

/** 受け入れ可能人数。報告があればその値、報告が一度もなければ病院設定の初期値。未確認と報告されていれば null */
export function effectiveCapacity(
  config: HospitalConfig,
  state: AppState,
  locationId: string,
  triage: string,
): { value: number | null; source: 'reported' | 'config' | 'unknown' } {
  const r = locationView(state, locationId).capacity[triage];
  if (r?.confirmedAt) return { value: r.value, source: r.value === null ? 'unknown' : 'reported' };
  const c = config.capacity.find((x) => x.locationId === locationId && x.triage === triage);
  return c ? { value: c.value, source: 'config' } : { value: null, source: 'unknown' };
}

/** 受け入れ可能人数の残り（区分ごと）。いま居る患者と、向かっている搬送を差し引く */
export function remainingCapacity(config: HospitalConfig, state: AppState, locationId: string, triage: string, excludeTransportId?: string) {
  const cap = effectiveCapacity(config, state, locationId, triage);
  const present = patientsAtLocation(state, locationId).filter((p) => p.triage === triage).length;
  const incoming = incomingTransports(state, locationId).filter(
    (t) => t.id !== excludeTransportId && state.patients[t.patientId]?.triage === triage,
  ).length;
  return { ...cap, present, incoming, remaining: cap.value === null ? null : cap.value - present - incoming };
}

export function decide(
  state: AppState,
  config: HospitalConfig,
  envelopeInput: CommandEnvelopeInput,
  ctx: DecideContext,
): DecideResult {
  const parsed = CommandEnvelopeSchema.safeParse(envelopeInput);
  if (!parsed.success) {
    return { status: 'rejected', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const { command, meta, expectedVersion, override } = parsed.data;
  const errors: string[] = [];

  const locationIds = new Set(config.locations.map((l) => l.id));
  const triageIds = new Set(config.triageCategories.map((t) => t.id));
  const locationName = (id: string) => config.locations.find((l) => l.id === id)?.name ?? id;
  if (!config.staff.some((s) => s.id === meta.enteredBy)) errors.push(`入力者「${meta.enteredBy}」が病院設定にない`);
  if (!locationIds.has(meta.terminal)) errors.push(`端末の場所「${meta.terminal}」が病院設定にない`);
  if (meta.reportedBy?.locationId && !locationIds.has(meta.reportedBy.locationId))
    errors.push(`報告元の場所「${meta.reportedBy.locationId}」が病院設定にない`);
  if (meta.reportedBy?.positionId && !config.positions.some((p) => p.id === meta.reportedBy!.positionId))
    errors.push(`報告元の役職「${meta.reportedBy.positionId}」が病院設定にない`);
  const observedAt = meta.observedAt ?? ctx.now;
  if (Date.parse(observedAt) - Date.parse(ctx.now) > FUTURE_TOLERANCE_MS)
    errors.push('現場で確認した時刻が未来になっている');

  const checkRefs = (type: EventType, payload: unknown) => {
    if (type === 'PatientRegistered') {
      const p = payload as z.infer<typeof PatientRegisteredPayload>;
      if (!locationIds.has(p.locationId)) errors.push(`所在「${p.locationId}」が病院設定にない`);
      if (p.departmentLocationId && !locationIds.has(p.departmentLocationId))
        errors.push(`担当部署「${p.departmentLocationId}」が病院設定にない`);
      if (p.triage !== null && !triageIds.has(p.triage)) errors.push(`トリアージ区分「${p.triage}」が病院設定にない`);
    }
    if (type === 'PatientTriageChanged') {
      const p = payload as z.infer<typeof PatientTriageChangedPayload>;
      if (p.triage !== null && !triageIds.has(p.triage)) errors.push(`トリアージ区分「${p.triage}」が病院設定にない`);
    }
    // 訂正の差し替えでも、搬送・場所の記録が設定にない値を指さないようにする
    if (type === 'TransportRequested') {
      const p = payload as z.infer<typeof payloadSchemas.TransportRequested>;
      if (!state.patients[p.patientId]) errors.push(`患者「${p.patientId}」が見つからない`);
      for (const loc of [p.fromLocationId, p.toLocationId]) if (!locationIds.has(loc)) errors.push(`場所「${loc}」が病院設定にない`);
      if (p.fromLocationId === p.toLocationId) errors.push('出発元と到着先が同じ');
      if (p.methodId && !config.transportMethods.some((m) => m.id === p.methodId)) errors.push(`搬送手段「${p.methodId}」が病院設定にない`);
      for (const e of p.escorts)
        if (!config.professions.some((x) => x.id === e.professionId)) errors.push(`付き添いの職種「${e.professionId}」が病院設定にない`);
    }
    if (type === 'TransportRedirected') {
      const p = payload as z.infer<typeof payloadSchemas.TransportRedirected>;
      if (!locationIds.has(p.toLocationId)) errors.push(`到着先「${p.toLocationId}」が病院設定にない`);
    }
    if (type === 'TransportStaffAssigned') {
      const p = payload as z.infer<typeof payloadSchemas.TransportStaffAssigned>;
      for (const id of p.transporterIds) if (!config.transporters.some((x) => x.id === id)) errors.push(`搬送要員「${id}」が病院設定にない`);
      if (p.teamId && !config.transporterTeams.some((x) => x.id === p.teamId)) errors.push(`搬送班「${p.teamId}」が病院設定にない`);
    }
    if (type === 'LocationStatusReported') {
      const p = payload as z.infer<typeof payloadSchemas.LocationStatusReported>;
      for (const c of p.capacity) if (!triageIds.has(c.triage)) errors.push(`トリアージ区分「${c.triage}」が病院設定にない`);
    }
    if (type === 'SupportRequested') {
      const p = payload as z.infer<typeof payloadSchemas.SupportRequested>;
      if (!locationIds.has(p.fromLocationId)) errors.push(`要請した場所「${p.fromLocationId}」が病院設定にない`);
      const kind = config.supportKinds.find((k) => k.id === p.kindId);
      if (!kind) errors.push(`要請の種類「${p.kindId}」が病院設定にない`);
      else checkSupportItems(kind.itemSource, p.items);
    }
    if (type === 'SupportDispatched') {
      const p = payload as z.infer<typeof payloadSchemas.SupportDispatched>;
      if (p.providerLocationId && !locationIds.has(p.providerLocationId)) errors.push(`手配先「${p.providerLocationId}」が病院設定にない`);
      if (p.toLocationId && !locationIds.has(p.toLocationId)) errors.push(`届け先「${p.toLocationId}」が病院設定にない`);
      if (p.orderedBy) checkDecider(p.orderedBy, '指示した人');
    }
    if (type === 'MessageLogged') {
      const p = payload as z.infer<typeof payloadSchemas.MessageLogged>;
      for (const loc of [p.fromLocationId, p.toLocationId]) if (loc && !locationIds.has(loc)) errors.push(`場所「${loc}」が病院設定にない`);
      for (const id of p.relatedIds)
        if (!state.patients[id] && !state.transports[id] && !state.supports[id]) errors.push(`関係する記録「${id}」が見つからない`);
    }
    if (type === 'SupportAssigned') {
      checkDecider((payload as z.infer<typeof payloadSchemas.SupportAssigned>).assignee, '担当者');
    }
    if (type === 'StaffCountReported') {
      const p = payload as z.infer<typeof payloadSchemas.StaffCountReported>;
      for (const c of p.counts) if (!config.professions.some((x) => x.id === c.professionId)) errors.push(`職種「${c.professionId}」が病院設定にない`);
    }
  };

  /** 要請の「何を」が種類に合っているか */
  function checkSupportItems(source: 'professions' | 'resources' | 'none', items: z.infer<typeof payloadSchemas.SupportRequested>['items']) {
    for (const it of items) {
      if (source === 'professions' && !config.professions.some((p) => p.id === it.professionId)) errors.push(`職種「${it.professionId ?? '（なし）'}」が病院設定にない`);
      if (source === 'resources' && !config.resources.some((r) => r.id === it.resourceId)) errors.push(`物品「${it.resourceId ?? '（なし）'}」が病院設定にない`);
      if (source === 'none' && !it.text) errors.push('何を求めるかを書く');
    }
  }

  /** 判断した人の確認。役職・職員が設定にあるか */
  const checkDecider = (d: Decider, label: string) => {
    if (d.positionId && !config.positions.some((p) => p.id === d.positionId)) errors.push(`${label}の役職「${d.positionId}」が病院設定にない`);
    if (d.staffId && !config.staff.some((s) => s.id === d.staffId)) errors.push(`${label}の職員「${d.staffId}」が病院設定にない`);
    if (!d.positionId && !d.staffId && !d.name) errors.push(`${label}（誰が判断したか）を記録する`);
  };

  const base = {
    reportedBy: meta.reportedBy,
    enteredBy: meta.enteredBy,
    terminal: meta.terminal,
    observedAt,
    recordedAt: ctx.now,
    mode: ctx.mode,
  };
  const warnings: DomainWarning[] = [];
  const duplicateCheck = (kind: 'tagNumber' | 'hospitalPatientId', value: string | undefined, selfId?: string) => {
    const hits = findPatientsByIdentifier(state, kind, value, selfId);
    if (hits.length === 0) return;
    warnings.push({
      code: kind === 'tagNumber' ? 'DUPLICATE_TAG_NUMBER' : 'DUPLICATE_HOSPITAL_PATIENT_ID',
      message: `同じ${identifierLabels[kind]}「${value}」の患者がすでにいます（${hits.map((h) => h.id).join('、')}）`,
      relatedPatientIds: hits.map((h) => h.id),
    });
  };

  let subject: Subject = { kind: 'patient', id: '' };
  let event: Omit<DomainEvent, 'id'> | undefined;
  const make = (type: EventType, payload: unknown, extra: Partial<DomainEvent> = {}) =>
    ({ ...base, type, subject, payload, ...extra }) as Omit<DomainEvent, 'id'>;

  /** 搬送の対象を取り出す。到着・中止で終わった搬送には、引き渡し以外の記録を足せない */
  const openTransport = (id: string, allowArrived = false) => {
    subject = { kind: 'transport', id };
    const t = state.transports[id];
    if (!t || t.retracted) {
      errors.push(`搬送「${id}」が見つからない`);
      return undefined;
    }
    if (t.steps.cancelled) errors.push(`${id} は中止されている`);
    else if (t.steps.arrived && !allowArrived) errors.push(`${id} は到着済み`);
    return t;
  };

  switch (command.type) {
    case 'RegisterPatient': {
      subject = { kind: 'patient', id: formatPatientId(state.registeredCount + 1) };
      checkRefs('PatientRegistered', command.payload);
      duplicateCheck('tagNumber', command.payload.tagNumber);
      duplicateCheck('hospitalPatientId', command.payload.hospitalPatientId);
      event = make('PatientRegistered', command.payload);
      break;
    }
    case 'CorrectPatientDetails': {
      const patient = state.patients[command.patientId];
      subject = { kind: 'patient', id: command.patientId };
      if (!patient || patient.retracted || patient.mergedInto) {
        errors.push(`患者「${command.patientId}」が見つからない`);
        break;
      }
      const f = command.payload.fields;
      for (const loc of [f.locationId, f.departmentLocationId]) if (loc && !locationIds.has(loc)) errors.push(`場所「${loc}」が病院設定にない`);
      // 搬送中の患者の所在は、搬送の記録（到着）で動かす
      if (f.locationId && activeTransportsForPatient(state, patient.id).some((t) => t.steps.departed))
        errors.push('搬送中の患者の所在は、搬送の到着で記録する');
      if (f.tagNumber) duplicateCheck('tagNumber', f.tagNumber, patient.id);
      if (f.hospitalPatientId) duplicateCheck('hospitalPatientId', f.hospitalPatientId, patient.id);
      event = make('PatientDetailsCorrected', command.payload);
      break;
    }
    case 'MergePatients': {
      const target = state.patients[command.patientId];
      const source = state.patients[command.payload.sourceId];
      subject = { kind: 'patient', id: command.patientId };
      if (!target || target.retracted || target.mergedInto) errors.push(`まとめ先の患者「${command.patientId}」が見つからない`);
      if (!source || source.retracted || source.mergedInto) errors.push(`まとめる患者「${command.payload.sourceId}」が見つからない`);
      if (command.patientId === command.payload.sourceId) errors.push('同じ患者どうしはまとめられない');
      // 進行中の搬送がある患者をまとめると、搬送の記録の対象が分からなくなる
      if (source && activeTransportsForPatient(state, source.id).length) errors.push(`${source.id} には進行中の搬送がある。搬送を終えてからまとめる`);
      event = make('PatientsMerged', command.payload);
      break;
    }
    case 'AddPatientIdentifier':
    case 'ChangePatientTriage':
    case 'UpdatePatientNote': {
      const patient = state.patients[command.patientId];
      subject = { kind: 'patient', id: command.patientId };
      if (!patient || patient.retracted || patient.mergedInto) {
        errors.push(`患者「${command.patientId}」が見つからない`);
        break;
      }
      const type = (
        {
          AddPatientIdentifier: 'PatientIdentifierAdded',
          ChangePatientTriage: 'PatientTriageChanged',
          UpdatePatientNote: 'PatientNoteUpdated',
        } as const
      )[command.type];
      checkRefs(type, command.payload);
      if (command.type === 'AddPatientIdentifier') {
        const { kind, value } = command.payload;
        if (kind === 'tagNumber' || kind === 'hospitalPatientId') duplicateCheck(kind, value, patient.id);
      }
      event = make(type, command.payload);
      break;
    }
    case 'CorrectEvent': {
      const target = state.eventMeta[command.eventId];
      if (!target) {
        errors.push(`訂正する記録「${command.eventId}」が見つからない`);
        break;
      }
      subject = target.subject;
      if (target.type === 'EventCorrected') errors.push('訂正の記録は訂正できない。元の記録に対して新しく訂正する');
      const { retract, replacement } = command.payload;
      if (!retract && !replacement) errors.push('取り消し（retract）か差し替え（replacement）のどちらかを指定する');
      // 引き渡しの有無は記録時の病院設定で決まるので、差し替えでは変えられない
      if (replacement && 'handover' in replacement) errors.push('到着の引き渡しの有無は差し替えられない');
      if (!retract && replacement) {
        const merged = { ...(target.payload as object), ...replacement };
        const r = payloadSchemas[target.type].safeParse(merged);
        if (!r.success) errors.push(...r.error.issues.map((i) => `replacement.${i.path.join('.')}: ${i.message}`));
        else checkRefs(target.type, r.data);
      }
      event = make('EventCorrected', command.payload, { corrects: command.eventId });
      break;
    }

    // ---- 搬送（調整・指示） ----
    case 'RequestTransport': {
      subject = { kind: 'transport', id: formatTransportId(state.requestedTransportCount + 1) };
      const p = command.payload;
      const patient = state.patients[p.patientId];
      if (!patient || patient.retracted || patient.mergedInto) {
        errors.push(`患者「${p.patientId}」が見つからない`);
        break;
      }
      const from = p.fromLocationId ?? patient.locationId;
      if (!locationIds.has(from)) errors.push(`出発元「${from}」が病院設定にない`);
      if (!locationIds.has(p.toLocationId)) errors.push(`到着先「${p.toLocationId}」が病院設定にない`);
      if (from === p.toLocationId) errors.push('出発元と到着先が同じ');
      if (p.methodId && !config.transportMethods.some((m) => m.id === p.methodId)) errors.push(`搬送手段「${p.methodId}」が病院設定にない`);
      for (const e of p.escorts)
        if (!config.professions.some((x) => x.id === e.professionId)) errors.push(`付き添いの職種「${e.professionId}」が病院設定にない`);
      const others = activeTransportsForPatient(state, patient.id);
      if (others.length > 0)
        warnings.push({
          code: 'DUPLICATE_ACTIVE_TRANSPORT',
          message: `${patient.id} にはすでに進行中の搬送があります（${others.map((t) => `${t.id}：${locationName(t.fromLocationId)}→${locationName(t.toLocationId)}`).join('、')}）`,
          relatedPatientIds: [patient.id],
          relatedTransportIds: others.map((t) => t.id),
        });
      event = make('TransportRequested', { ...p, fromLocationId: from });
      break;
    }
    case 'AcceptTransport':
    case 'DeclineTransport': {
      const t = openTransport(command.transportId);
      if (!t) break;
      const d = command.payload.decidedBy;
      checkDecider(d, '判断した人');
      const policy = config.transportPolicy.acceptanceDecidedBy;
      const position = config.positions.find((x) => x.id === d.positionId);
      if (policy === 'location-lead') {
        // 判断は到着先の責任者（または代行者）。入力は誰がしてもよい
        if (!position || position.locationId !== t.toLocationId || !position.permissions.includes('accept-transport'))
          errors.push(`受け入れの判断は「${locationName(t.toLocationId)}」の責任者（または代行者）が行う。判断した役職を選ぶ`);
      } else {
        const staff = config.staff.find((s) => s.id === d.staffId);
        const atLocation = position?.locationId === t.toLocationId || staff?.locationId === t.toLocationId || (!position && !staff && !!d.name);
        if (!atLocation) errors.push(`受け入れの判断は「${locationName(t.toLocationId)}」の担当者が行う`);
      }
      if (command.type === 'AcceptTransport') {
        const triage = state.patients[t.patientId]?.triage;
        if (triage) {
          const r = remainingCapacity(config, state, t.toLocationId, triage, t.id);
          if (r.remaining !== null && r.remaining <= 0) {
            const label = config.triageCategories.find((c) => c.id === triage)?.label ?? triage;
            warnings.push({
              code: 'CAPACITY_EXCEEDED',
              message: `${locationName(t.toLocationId)}の${label}の受け入れ可能人数（${r.value}人${r.source === 'config' ? '・設定の初期値' : ''}）を超えます（いま${r.present}人、向かっている${r.incoming}人）`,
              relatedPatientIds: [t.patientId],
              relatedTransportIds: [t.id],
            });
          }
        }
        event = make('TransportAccepted', command.payload);
      } else {
        event = make('TransportDeclined', command.payload);
      }
      break;
    }
    case 'AssignTransportStaff': {
      const t = openTransport(command.transportId);
      if (!t) break;
      const { transporterIds, teamId } = command.payload;
      if (teamId && !config.transporterTeams.some((x) => x.id === teamId)) errors.push(`搬送班「${teamId}」が病院設定にない`);
      const busy: string[] = [];
      for (const id of transporterIds) {
        const tr = config.transporters.find((x) => x.id === id);
        if (!tr) {
          errors.push(`搬送要員「${id}」が病院設定にない`);
          continue;
        }
        const s = transporterStatus(state, id);
        if (s.status === 'unavailable') busy.push(`${tr.name}（対応不可）`);
        else if (s.transportId && s.transportId !== t.id) busy.push(`${tr.name}（${s.transportId}で${s.status === 'moving' ? '移動中' : '割当済'}）`);
      }
      if (busy.length > 0)
        warnings.push({
          code: 'TRANSPORTER_BUSY',
          message: `稼働中または対応不可の搬送要員がいます：${busy.join('、')}`,
          relatedPatientIds: [t.patientId],
          relatedTransportIds: [t.id],
        });
      event = make('TransportStaffAssigned', command.payload);
      break;
    }
    case 'OrderTransport': {
      const t = openTransport(command.transportId);
      if (!t) break;
      const d = command.payload.orderedBy;
      checkDecider(d, '指示した人');
      // 搬送の指示を出すのは本部（本部内の搬送調整担当を含む）
      const position = config.positions.find((x) => x.id === d.positionId);
      if (!position?.permissions.includes('direct-transport')) errors.push('搬送の指示は、搬送を指示できる役職（本部）が行う。指示した役職を選ぶ');
      event = make('TransportOrdered', command.payload);
      break;
    }
    case 'AcknowledgeTransport': {
      if (!openTransport(command.transportId)) break;
      event = make('TransportAcknowledged', command.payload);
      break;
    }
    case 'CancelTransport': {
      if (!openTransport(command.transportId)) break;
      event = make('TransportCancelled', command.payload);
      break;
    }
    case 'RedirectTransport': {
      const t = openTransport(command.transportId);
      if (!t) break;
      const to = command.payload.toLocationId;
      if (!locationIds.has(to)) errors.push(`到着先「${to}」が病院設定にない`);
      if (to === t.toLocationId) errors.push('いまの行き先と同じ');
      if (to === t.fromLocationId && !t.steps.departed) errors.push('出発前の行き先を出発元と同じにはできない（中止を記録する）');
      event = make('TransportRedirected', command.payload);
      break;
    }

    // ---- 搬送（事実）。調整が未記録でも記録できる ----
    case 'RecordDeparture': {
      const t = openTransport(command.transportId);
      if (!t) break;
      if (t.steps.departed) errors.push(`${t.id} の出発は記録済み`);
      event = make('TransportDeparted', command.payload);
      break;
    }
    case 'RecordArrival': {
      if (!openTransport(command.transportId)) break;
      event = make('TransportArrived', { ...command.payload, handover: config.transportPolicy.handoverOnArrival });
      break;
    }
    case 'RecordHandover': {
      const t = openTransport(command.transportId, true);
      if (!t) break;
      if (config.transportPolicy.handoverOnArrival) errors.push('この病院では到着と同時に引き渡しを記録する');
      else if (!t.steps.arrived) errors.push(`${t.id} はまだ到着していない`);
      else if (t.steps.handedOver || t.steps.arrived.handover) errors.push(`${t.id} の引き渡しは記録済み`);
      event = make('TransportHandedOver', command.payload);
      break;
    }

    // ---- 搬送要員 ----
    case 'SetTransporterAvailability': {
      subject = { kind: 'transporter', id: command.transporterId };
      if (!config.transporters.some((x) => x.id === command.transporterId)) errors.push(`搬送要員「${command.transporterId}」が病院設定にない`);
      event = make('TransporterAvailabilityChanged', command.payload);
      break;
    }

    // ---- 支援要請 ----
    case 'RequestSupport': {
      subject = { kind: 'support', id: formatSupportId(state.requestedSupportCount + 1) };
      checkRefs('SupportRequested', command.payload);
      event = make('SupportRequested', command.payload);
      break;
    }
    case 'AssignSupport':
    case 'DispatchSupport':
    case 'RecordSupportReceived':
    case 'CompleteSupport':
    case 'CancelSupport': {
      subject = { kind: 'support', id: command.supportId };
      const s = state.supports[command.supportId];
      if (!s || s.retracted) {
        errors.push(`支援要請「${command.supportId}」が見つからない`);
        break;
      }
      if (s.closed) errors.push(`${s.id} は${s.steps.cancelled ? '中止' : '完了'}している`);
      const type = (
        {
          AssignSupport: 'SupportAssigned',
          DispatchSupport: 'SupportDispatched',
          RecordSupportReceived: 'SupportReceived',
          CompleteSupport: 'SupportCompleted',
          CancelSupport: 'SupportCancelled',
        } as const
      )[command.type];
      checkRefs(type, command.payload);
      if (command.type === 'DispatchSupport' && command.payload.items) {
        const kind = config.supportKinds.find((k) => k.id === s.kindId);
        if (kind) checkSupportItems(kind.itemSource, command.payload.items);
      }
      if (command.type === 'RecordSupportReceived' && s.steps.received) errors.push(`${s.id} の受け取りは記録済み`);
      event = make(type, command.payload);
      break;
    }

    // ---- 連絡メモ ----
    case 'LogMessage': {
      subject = { kind: 'message', id: formatMessageId(state.messageCount + 1) };
      checkRefs('MessageLogged', command.payload);
      event = make('MessageLogged', command.payload);
      break;
    }

    // ---- 場所 ----
    case 'ReportLocationStatus': {
      subject = { kind: 'location', id: command.locationId };
      if (!locationIds.has(command.locationId)) errors.push(`場所「${command.locationId}」が病院設定にない`);
      for (const c of command.payload.capacity) if (!triageIds.has(c.triage)) errors.push(`トリアージ区分「${c.triage}」が病院設定にない`);
      event = make('LocationStatusReported', command.payload);
      break;
    }
    case 'ReportStaffCount': {
      subject = { kind: 'location', id: command.locationId };
      if (!locationIds.has(command.locationId)) errors.push(`場所「${command.locationId}」が病院設定にない`);
      for (const c of command.payload.counts)
        if (!config.professions.some((x) => x.id === c.professionId)) errors.push(`職種「${c.professionId}」が病院設定にない`);
      event = make('StaffCountReported', command.payload);
      break;
    }
  }

  if (errors.length > 0 || !event) return { status: 'rejected', errors };

  // 版番号の確認（新しく作る・報告を足すだけのコマンドは競合しない）
  if (!versionFree.has(command.type)) {
    const currentVersion = versionOf(state, subject);
    if (expectedVersion === undefined) return { status: 'rejected', errors: ['expectedVersion を指定する'] };
    if (expectedVersion !== currentVersion) return { status: 'conflict', subject, expectedVersion, currentVersion };
  }

  // 警告はブロックしない。すべての警告コードを承知した理由つきの再送なら実行する
  if (warnings.length > 0) {
    if (!override || !warnings.every((w) => override.codes.includes(w.code))) return { status: 'warnings', warnings };
  }

  const recorded: Override | undefined = warnings.length > 0 ? override : undefined;
  return {
    status: 'accepted',
    events: [{ ...event, id: ctx.newId(), ...(recorded ? { override: recorded } : {}) } as DomainEvent],
  };
}
