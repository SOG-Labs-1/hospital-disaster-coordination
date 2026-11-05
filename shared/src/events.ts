import { z } from 'zod';

// 記録（イベント）の定義。すべての操作はイベントとして追記し、上書き・削除はしない。

export const modes = ['live', 'training'] as const;
export const ModeSchema = z.enum(modes);
export type Mode = z.infer<typeof ModeSchema>;

export const modeLabels: Record<Mode, string> = { live: '災害運用', training: '訓練' };

const isoDateTime = z.iso.datetime({ offset: true });

/** 報告元（無線・電話で報告してきた人）。分かる項目だけ入れる */
/**
 * 患者・搬送・要請・記録・場所・職員などの番号。英数字で始まり、英数字・ハイフン・下線だけ（64文字まで）。
 * "__proto__" のような名前を番号として受け付けない（細工した1件で集計が壊れないように）
 */
export const RefIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, '番号の形が正しくない');

export const ReporterSchema = z.object({
  positionId: z.string().max(200).optional(),
  locationId: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
});
export type Reporter = z.infer<typeof ReporterSchema>;

export const SubjectSchema = z.object({
  kind: z.enum(['patient', 'transport', 'transporter', 'location', 'support', 'message', 'staff']),
  id: z.string().max(200).min(1),
});
export type Subject = z.infer<typeof SubjectSchema>;

/** 警告を承知で実行したときの記録 */
export const OverrideSchema = z.object({
  codes: z.array(z.string().max(200)).max(100).min(1),
  reasonId: z.string().max(200).optional(),
  reason: z.string().trim().max(1000).min(1, '理由を書いてください'),
});
export type Override = z.infer<typeof OverrideSchema>;

export const sexes = ['male', 'female', 'unknown'] as const;
export const sexLabels: Record<(typeof sexes)[number], string> = { male: '男性', female: '女性', unknown: '不明' };

const optionalText = z.string().trim().max(1000).optional();

export const PatientRegisteredPayload = z.object({
  tagNumber: optionalText,
  hospitalPatientId: optionalText,
  medicalId: optionalText,
  name: optionalText,
  sex: z.enum(sexes).default('unknown'),
  estimatedAge: optionalText,
  features: optionalText,
  /** トリアージ区分の id（病院設定）。未判定は null */
  triage: z.string().max(200).nullable().default(null),
  /** 所在（物理的にいる場所） */
  locationId: z.string().max(200).min(1),
  /** 担当部署。省略時は所在と同じ */
  departmentLocationId: z.string().max(200).optional(),
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
  value: z.string().trim().max(1000).min(1),
});

export const PatientTriageChangedPayload = z.object({
  triage: z.string().max(200).nullable(),
});

export const noteFields = ['features', 'conditionNote', 'freeNote'] as const;
export const noteFieldLabels: Record<(typeof noteFields)[number], string> = {
  features: '特徴メモ',
  conditionNote: '状態メモ',
  freeNote: '自由メモ',
};

export const PatientNoteUpdatedPayload = z.object({
  field: z.enum(noteFields),
  value: z.string().max(200),
});

/**
 * 患者の登録内容の訂正（理由つき）。書いた項目だけを直す。
 * 搬送なしで所在が違っていた（登録時の場所の間違いなど）ときも、ここで所在を直す
 */
export const PatientDetailsCorrectedPayload = z.object({
  fields: z
    .object({
      tagNumber: optionalText,
      hospitalPatientId: optionalText,
      medicalId: optionalText,
      name: optionalText,
      sex: z.enum(sexes).optional(),
      estimatedAge: optionalText,
      features: optionalText,
      conditionNote: optionalText,
      locationId: z.string().max(200).optional(),
      departmentLocationId: z.string().max(200).optional(),
    })
    .refine((f) => Object.values(f).some((v) => v !== undefined), '直す項目を1つ以上書く'),
  reason: z.string().trim().max(1000).min(1),
});

/** 同じ人だと分かった2件の記録を1つにまとめる。subject がまとめ先、sourceId がまとめられる側 */
export const PatientsMergedPayload = z.object({
  sourceId: RefIdSchema,
  reason: z.string().trim().max(1000).min(1),
});

/** 訂正。対象のイベント（corrects）を取り消すか、中身を差し替える */
export const EventCorrectedPayload = z.object({
  reason: z.string().trim().max(1000).min(1),
  /** true なら対象を取り消す（なかったことにする） */
  retract: z.boolean().default(false),
  /** 差し替える中身（対象イベントの payload と同じ形） */
  replacement: z.record(z.string().max(200), z.unknown()).optional(),
});

// ---- 搬送 ----
// 「調整・指示（依頼したこと）」と「事実（起きたこと）」を別のイベントで記録する。
// 調整が未記録でも事実は記録でき、欠けた段階は画面で「未記録」と示す。

/** 判断した人（受け入れ了承・指示など）。入力者（enteredBy）とは別に記録する */
export const DeciderSchema = z.object({
  positionId: z.string().max(200).optional(),
  staffId: z.string().max(200).optional(),
  name: z.string().trim().max(1000).optional(),
  /** 責任者の代行として判断した */
  asDeputy: z.boolean().default(false),
});
export type Decider = z.infer<typeof DeciderSchema>;

export const EscortSchema = z.object({ professionId: z.string().max(200), count: z.number().int().min(1).max(999) });

export const TransportRequestedPayload = z.object({
  patientId: RefIdSchema,
  fromLocationId: z.string().max(200).min(1),
  toLocationId: z.string().max(200).min(1),
  methodId: z.string().max(200).optional(),
  escorts: z.array(EscortSchema).max(100).default([]),
  note: optionalText,
});
export const TransportAcceptedPayload = z.object({ decidedBy: DeciderSchema, note: optionalText });
export const TransportDeclinedPayload = z.object({ decidedBy: DeciderSchema, reason: z.string().trim().max(1000).min(1) });
export const TransportStaffAssignedPayload = z.object({
  transporterIds: z.array(RefIdSchema).max(100).min(1),
  teamId: z.string().max(200).optional(),
});
export const TransportOrderedPayload = z.object({ orderedBy: DeciderSchema, note: optionalText });
export const TransportAcknowledgedPayload = z.object({ note: optionalText });
export const TransportCancelledPayload = z.object({ reason: z.string().trim().max(1000).min(1) });
export const TransportRedirectedPayload = z.object({ toLocationId: z.string().max(200).min(1), reason: z.string().trim().max(1000).min(1) });
export const TransportDepartedPayload = z.object({ note: optionalText });
/** 到着。病院設定で到着＝引き渡しの場合は、所在と担当部署が同時に移る */
export const TransportArrivedPayload = z.object({
  note: optionalText,
  /** この到着で引き渡し（担当部署の移動）も済んだか。記録時の病院設定で決まる */
  handover: z.boolean().default(true),
});
/** 引き渡し（到着と分ける病院だけで使う） */
export const TransportHandedOverPayload = z.object({ note: optionalText });

// ---- 支援要請 ----
// 要請 → 本部の受付（担当） → 手配の指示（誰に・何を・どこへ） → 届いた（要請した側が記録） → 完了

/** 何を求めるか。職種・資源は病院設定の id、その他は自由記述 */
export const SupportItemSchema = z.object({
  professionId: z.string().max(200).optional(),
  resourceId: z.string().max(200).optional(),
  text: z.string().trim().max(1000).optional(),
  quantity: z.number().int().min(1).max(99999).nullable().default(null),
});
export type SupportItem = z.infer<typeof SupportItemSchema>;

export const SupportRequestedPayload = z.object({
  /** 要請した場所（部署または本部） */
  fromLocationId: z.string().max(200).min(1),
  kindId: z.string().max(200).min(1),
  items: z.array(SupportItemSchema).min(1).max(50),
  note: optionalText,
});
export const SupportAssignedPayload = z.object({ assignee: DeciderSchema, note: optionalText });
export const SupportDispatchedPayload = z.object({
  /** 誰に（手配先の場所。外部などは providerName） */
  providerLocationId: z.string().max(200).optional(),
  providerName: z.string().trim().max(1000).optional(),
  /** 何を（省略時は要請どおり） */
  items: z.array(SupportItemSchema).max(50).optional(),
  /** どこへ（省略時は要請した場所） */
  toLocationId: z.string().max(200).optional(),
  orderedBy: DeciderSchema.optional(),
  note: optionalText,
});
export const SupportReceivedPayload = z.object({ note: optionalText });
export const SupportCompletedPayload = z.object({ note: optionalText });
export const SupportCancelledPayload = z.object({ reason: z.string().trim().max(1000).min(1) });

// ---- 連絡メモ（無線・電話などのやりとりをそのまま残す） ----
export const messageChannels = ['radio', 'phone', 'in-person', 'other'] as const;
export const messageChannelLabels: Record<(typeof messageChannels)[number], string> = {
  radio: '無線',
  phone: '電話',
  'in-person': '対面',
  other: 'その他',
};

export const MessageLoggedPayload = z.object({
  channel: z.enum(messageChannels),
  /** 発信元・宛先の場所（分かれば） */
  fromLocationId: z.string().max(200).optional(),
  toLocationId: z.string().max(200).optional(),
  text: z.string().trim().max(1000).min(1),
  /** 関係する患者・搬送・要請（例：P-001、T-002） */
  relatedIds: z.array(RefIdSchema).max(100).default([]),
});

// ---- 入力者（職員）の追加 ----
/** 画面から追加した入力者。病院設定の職員一覧に加えて、名前の一覧から選べる */
export const StaffRegisteredPayload = z.object({
  name: z.string().trim().max(1000).min(2, 'フルネームで書く'),
  locationId: z.string().max(200).min(1),
  professionId: z.string().max(200).min(1),
  staffNumber: z.string().trim().max(1000).optional(),
});

// ---- 場所と災害時の用途（ゾーン）の対応の変更 ----
/** その場所の用途を、確認時刻（observedAt）から変える。空の配列なら用途なし */
export const ZoneAssignmentChangedPayload = z.object({
  zoneIds: z.array(z.string().max(200)).max(100),
  note: optionalText,
});

// ---- 搬送要員 ----
export const TransporterAvailabilityChangedPayload = z.object({
  available: z.boolean(),
  note: optionalText,
});

// ---- 場所 ----
/** 数値の報告。null は「未確認」。確認時刻はイベントの observedAt */
const reportedCount = z.number().int().min(0).max(99999).nullable();

export const LocationStatusReportedPayload = z.object({
  /** 受け入れ可否。null は未確認 */
  accepting: z.boolean().nullable().optional(),
  /** 区分ごとの受け入れ可能人数（報告した区分だけ更新する） */
  capacity: z.array(z.object({ triage: z.string().max(200), value: reportedCount })).max(50).default([]),
  note: optionalText,
});
export const StaffCountReportedPayload = z.object({
  counts: z.array(z.object({ professionId: z.string().max(200), value: reportedCount })).min(1).max(50),
});

export const payloadSchemas = {
  PatientRegistered: PatientRegisteredPayload,
  PatientIdentifierAdded: PatientIdentifierAddedPayload,
  PatientTriageChanged: PatientTriageChangedPayload,
  PatientNoteUpdated: PatientNoteUpdatedPayload,
  PatientDetailsCorrected: PatientDetailsCorrectedPayload,
  PatientsMerged: PatientsMergedPayload,
  EventCorrected: EventCorrectedPayload,
  TransportRequested: TransportRequestedPayload,
  TransportAccepted: TransportAcceptedPayload,
  TransportDeclined: TransportDeclinedPayload,
  TransportStaffAssigned: TransportStaffAssignedPayload,
  TransportOrdered: TransportOrderedPayload,
  TransportAcknowledged: TransportAcknowledgedPayload,
  TransportCancelled: TransportCancelledPayload,
  TransportRedirected: TransportRedirectedPayload,
  TransportDeparted: TransportDepartedPayload,
  TransportArrived: TransportArrivedPayload,
  TransportHandedOver: TransportHandedOverPayload,
  TransporterAvailabilityChanged: TransporterAvailabilityChangedPayload,
  SupportRequested: SupportRequestedPayload,
  SupportAssigned: SupportAssignedPayload,
  SupportDispatched: SupportDispatchedPayload,
  SupportReceived: SupportReceivedPayload,
  SupportCompleted: SupportCompletedPayload,
  SupportCancelled: SupportCancelledPayload,
  MessageLogged: MessageLoggedPayload,
  StaffRegistered: StaffRegisteredPayload,
  ZoneAssignmentChanged: ZoneAssignmentChangedPayload,
  LocationStatusReported: LocationStatusReportedPayload,
  StaffCountReported: StaffCountReportedPayload,
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
    id: z.string().max(200).min(1),
    type: z.enum(eventTypes as [EventType, ...EventType[]]),
    subject: SubjectSchema,
    payload: z.unknown(),
    reportedBy: ReporterSchema.nullable(),
    enteredBy: z.string().max(200).min(1),
    terminal: z.string().max(200).min(1),
    observedAt: isoDateTime,
    recordedAt: isoDateTime,
    corrects: z.string().max(200).optional(),
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
