import { z } from 'zod';
import type { HospitalConfig } from './config';
import {
  EventCorrectedPayload,
  OverrideSchema,
  PatientIdentifierAddedPayload,
  PatientNoteUpdatedPayload,
  PatientRegisteredPayload,
  PatientTriageChangedPayload,
  ReporterSchema,
  identifierLabels,
  payloadSchemas,
  type DomainEvent,
  type EventType,
  type Mode,
  type Override,
  type Subject,
} from './events';
import { findPatientsByIdentifier, formatPatientId, versionOf, type AppState } from './state';

// コマンド（画面からの依頼）を検証し、追記するイベントを決める。
// ここは純粋な関数で、保存や配信はしない。

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('RegisterPatient'), payload: PatientRegisteredPayload }),
  z.object({ type: z.literal('AddPatientIdentifier'), patientId: z.string(), payload: PatientIdentifierAddedPayload }),
  z.object({ type: z.literal('ChangePatientTriage'), patientId: z.string(), payload: PatientTriageChangedPayload }),
  z.object({ type: z.literal('UpdatePatientNote'), patientId: z.string(), payload: PatientNoteUpdatedPayload }),
  z.object({ type: z.literal('CorrectEvent'), eventId: z.string(), payload: EventCorrectedPayload }),
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
  /** 対象の版番号。新規登録では省略できる */
  expectedVersion: z.number().int().min(0).optional(),
  override: OverrideSchema.optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;
export type CommandEnvelopeInput = z.input<typeof CommandEnvelopeSchema>;

export const warningCodes = {
  DUPLICATE_TAG_NUMBER: 'DUPLICATE_TAG_NUMBER',
  DUPLICATE_HOSPITAL_PATIENT_ID: 'DUPLICATE_HOSPITAL_PATIENT_ID',
} as const;
export type WarningCode = keyof typeof warningCodes;

export interface DomainWarning {
  code: WarningCode;
  message: string;
  relatedPatientIds: string[];
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

  let subject: Subject;
  let event: Omit<DomainEvent, 'id'> | undefined;

  switch (command.type) {
    case 'RegisterPatient': {
      subject = { kind: 'patient', id: formatPatientId(state.registeredCount + 1) };
      checkRefs('PatientRegistered', command.payload);
      duplicateCheck('tagNumber', command.payload.tagNumber);
      duplicateCheck('hospitalPatientId', command.payload.hospitalPatientId);
      event = { ...base, type: 'PatientRegistered', subject, payload: command.payload } as Omit<DomainEvent, 'id'>;
      break;
    }
    case 'AddPatientIdentifier':
    case 'ChangePatientTriage':
    case 'UpdatePatientNote': {
      const patient = state.patients[command.patientId];
      subject = { kind: 'patient', id: command.patientId };
      if (!patient || patient.retracted) {
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
      event = { ...base, type, subject, payload: command.payload } as Omit<DomainEvent, 'id'>;
      break;
    }
    case 'CorrectEvent': {
      const target = state.eventMeta[command.eventId];
      if (!target) {
        errors.push(`訂正する記録「${command.eventId}」が見つからない`);
        subject = { kind: 'patient', id: '' };
        break;
      }
      subject = target.subject;
      if (target.type === 'EventCorrected') errors.push('訂正の記録は訂正できない。元の記録に対して新しく訂正する');
      const { retract, replacement } = command.payload;
      if (!retract && !replacement) errors.push('取り消し（retract）か差し替え（replacement）のどちらかを指定する');
      if (!retract && replacement) {
        const merged = { ...(target.payload as object), ...replacement };
        const r = payloadSchemas[target.type].safeParse(merged);
        if (!r.success) errors.push(...r.error.issues.map((i) => `replacement.${i.path.join('.')}: ${i.message}`));
        else checkRefs(target.type, r.data);
      }
      event = {
        ...base,
        type: 'EventCorrected',
        subject,
        corrects: command.eventId,
        payload: command.payload,
      } as Omit<DomainEvent, 'id'>;
      break;
    }
  }

  if (errors.length > 0 || !event) return { status: 'rejected', errors };

  // 版番号の確認（新規登録は管理番号をサーバーが発行するので競合しない）
  if (command.type !== 'RegisterPatient') {
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
