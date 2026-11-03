import { z } from 'zod';

// 記録（イベント）の定義。すべての操作はイベントとして追記し、上書き・削除はしない。

export const modes = ['live', 'training'] as const;
export const ModeSchema = z.enum(modes);
export type Mode = z.infer<typeof ModeSchema>;

export const modeLabels: Record<Mode, string> = { live: '実運用', training: '訓練' };

const isoDateTime = z.iso.datetime({ offset: true });

/** 報告元（無線・電話で報告してきた人）。分かる項目だけ入れる */
export const ReporterSchema = z.object({
  positionId: z.string().optional(),
  locationId: z.string().optional(),
  name: z.string().optional(),
});
export type Reporter = z.infer<typeof ReporterSchema>;

export const SubjectSchema = z.object({
  kind: z.enum(['patient']),
  id: z.string().min(1),
});
export type Subject = z.infer<typeof SubjectSchema>;

/** 警告を承知で実行したときの記録 */
export const OverrideSchema = z.object({
  codes: z.array(z.string()).min(1),
  reasonId: z.string().optional(),
  reason: z.string().trim().min(1, '理由を書いてください'),
});
export type Override = z.infer<typeof OverrideSchema>;

export const sexes = ['male', 'female', 'unknown'] as const;
export const sexLabels: Record<(typeof sexes)[number], string> = { male: '男性', female: '女性', unknown: '不明' };

const optionalText = z.string().trim().optional();

export const PatientRegisteredPayload = z.object({
  tagNumber: optionalText,
  hospitalPatientId: optionalText,
  medicalId: optionalText,
  name: optionalText,
  sex: z.enum(sexes).default('unknown'),
  estimatedAge: optionalText,
  features: optionalText,
  /** トリアージ区分の id（病院設定）。未判定は null */
  triage: z.string().nullable().default(null),
  /** 所在（物理的にいる場所） */
  locationId: z.string().min(1),
  /** 担当部署。省略時は所在と同じ */
  departmentLocationId: z.string().optional(),
  conditionNote: optionalText,
  freeNote: optionalText,
});

export const identifierKinds = ['tagNumber', 'hospitalPatientId', 'medicalId', 'name'] as const;
export const identifierLabels: Record<(typeof identifierKinds)[number], string> = {
  tagNumber: 'タッグ番号',
  hospitalPatientId: '院内患者ID',
  medicalId: 'メディカルID',
  name: '氏名',
};

export const PatientIdentifierAddedPayload = z.object({
  kind: z.enum(identifierKinds),
  value: z.string().trim().min(1),
});

export const PatientTriageChangedPayload = z.object({
  triage: z.string().nullable(),
});

export const noteFields = ['features', 'conditionNote', 'freeNote'] as const;
export const noteFieldLabels: Record<(typeof noteFields)[number], string> = {
  features: '特徴メモ',
  conditionNote: '状態メモ',
  freeNote: '自由メモ',
};

export const PatientNoteUpdatedPayload = z.object({
  field: z.enum(noteFields),
  value: z.string(),
});

/** 訂正。対象のイベント（corrects）を取り消すか、中身を差し替える */
export const EventCorrectedPayload = z.object({
  reason: z.string().trim().min(1),
  /** true なら対象を取り消す（なかったことにする） */
  retract: z.boolean().default(false),
  /** 差し替える中身（対象イベントの payload と同じ形） */
  replacement: z.record(z.string(), z.unknown()).optional(),
});

export const payloadSchemas = {
  PatientRegistered: PatientRegisteredPayload,
  PatientIdentifierAdded: PatientIdentifierAddedPayload,
  PatientTriageChanged: PatientTriageChangedPayload,
  PatientNoteUpdated: PatientNoteUpdatedPayload,
  EventCorrected: EventCorrectedPayload,
} as const;

export type EventType = keyof typeof payloadSchemas;
export const eventTypes = Object.keys(payloadSchemas) as EventType[];

export type PayloadOf<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

export interface EventBase<T extends EventType = EventType> {
  /** ULID */
  id: string;
  type: T;
  subject: Subject;
  payload: PayloadOf<T>;
  reportedBy: Reporter | null;
  /** 入力者（病院設定の staff の id） */
  enteredBy: string;
  /** 入力した端末の場所 id */
  terminal: string;
  /** 現場で確認した時刻 */
  observedAt: string;
  /** サーバーが記録した時刻 */
  recordedAt: string;
  /** 訂正の場合、訂正対象のイベント id */
  corrects?: string;
  override?: Override;
  mode: Mode;
}

export type DomainEvent = { [T in EventType]: EventBase<T> }[EventType];

export const DomainEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(eventTypes as [EventType, ...EventType[]]),
    subject: SubjectSchema,
    payload: z.unknown(),
    reportedBy: ReporterSchema.nullable(),
    enteredBy: z.string().min(1),
    terminal: z.string().min(1),
    observedAt: isoDateTime,
    recordedAt: isoDateTime,
    corrects: z.string().optional(),
    override: OverrideSchema.optional(),
    mode: ModeSchema,
  })
  .transform((e, ctx) => {
    const r = payloadSchemas[e.type].safeParse(e.payload);
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['payload', ...i.path], message: i.message });
      return z.NEVER;
    }
    return { ...e, payload: r.data } as DomainEvent;
  });

export function subjectKey(subject: Subject): string {
  return `${subject.kind}:${subject.id}`;
}
