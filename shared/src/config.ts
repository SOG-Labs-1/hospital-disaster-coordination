import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

// 病院設定（config/hospitals/*.yaml）のスキーマ。
// 病院固有の値（場所・ゾーン・役職・トリアージの表示など）はすべてここを通して読む。

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'id は英小文字・数字・ハイフンで書く（例: er, ward-3）');

const isoDateTime = z.iso.datetime({ offset: true });

export const locationKinds = [
  'headquarters',
  'emergency',
  'outpatient',
  'ward',
  'operating-room',
  'icu',
  'hall',
  'rehabilitation',
  'other',
] as const;

export const LocationSchema = z.object({
  id,
  name: z.string().min(1),
  kind: z.enum(locationKinds),
  hasTerminal: z.boolean(),
  routeNote: z.string().optional(),
});

export const ZoneSchema = z.object({
  id,
  name: z.string().min(1),
  /** このゾーンで主に受け入れるトリアージ区分 */
  triage: z.array(id).default([]),
});

export const ZoneAssignmentSchema = z.object({
  zoneId: id,
  locationId: id,
  /** 開始時刻。省略時は災害対応の開始時点から */
  from: isoDateTime.nullable().default(null),
  /** 終了時刻（この時刻からは使わない）。省略時は終わりなし */
  until: isoDateTime.nullable().default(null),
});

export const TriageCategorySchema = z.object({
  id,
  /** 画面に出す文字（例: 赤） */
  label: z.string().min(1),
  /** 色に頼らず区別するための記号（例: ■ ▲ ● ✕） */
  symbol: z.string().min(1),
  /** 色以外の区別を補う短い説明（例: 最優先治療） */
  description: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** 白黒印刷での枠線 */
  printBorder: z.enum(['solid', 'double', 'dashed', 'dotted']),
});

export const ProfessionSchema = z.object({ id, name: z.string().min(1) });

/**
 * 権限キー。コードが意味を決める固定のキーで、どの役職に持たせるかを病院設定で決める。
 * 書き間違いで誰も操作できなくなるのを防ぐため、知らないキーは読み込み時に誤りにする
 */
export const permissionKeys = ['accept-transport', 'direct-transport', 'register-patient', 'assign-support'] as const;
export type PermissionKey = (typeof permissionKeys)[number];

export const PositionSchema = z.object({
  id,
  name: z.string().min(1),
  /** その役職が属する場所（本部など）。省略時は場所に縛られない */
  locationId: id.optional(),
  permissions: z.array(z.enum(permissionKeys)).default([]),
});

export const StaffSchema = z.object({
  id,
  name: z.string().min(1),
  professionId: id,
  /** 主にいる場所。入力者の一覧を端末ごとに絞り込むのに使う */
  locationId: id.optional(),
  /** 職員番号（任意） */
  staffNumber: z.string().optional(),
});

export const CapacitySchema = z.object({
  locationId: id,
  triage: id,
  value: z.number().int().min(0),
});

export const WarningReasonSchema = z.object({
  id,
  label: z.string().min(1),
  /** true なら補足の記入を必須にする（「その他」など） */
  requiresDetail: z.boolean().default(false),
  /**
   * この理由を出す警告の種類（警告コード）。省略するとすべての警告で出す。
   * 警告ごとに合う理由だけを出して、迷わず選べるようにする
   */
  appliesTo: z.array(z.string().min(1)).optional(),
});

export const ResourceSchema = z.object({ id, name: z.string().min(1), unit: z.string().min(1) });

export const ChecklistItemSchema = z.object({ id, text: z.string().min(1) });

/** 搬送要員（1人ずつ登録する） */
export const TransporterSchema = z.object({ id, name: z.string().min(1) });

/** よく組む搬送班。まとめて割り当てられる */
export const TransporterTeamSchema = z.object({ id, name: z.string().min(1), members: z.array(id).min(1) });

/** 搬送手段（独歩・車いす・ストレッチャーなど） */
export const TransportMethodSchema = z.object({ id, name: z.string().min(1) });

/**
 * 支援要請の種類。itemSource で「何を」の選び方を決める
 * professions: 職種と人数（人員の要請） / resources: 資源と数量（物品の要請） / none: 自由記述（その他）
 */
export const SupportKindSchema = z.object({
  id,
  name: z.string().min(1),
  itemSource: z.enum(['professions', 'resources', 'none']),
});

export const supportSteps = ['requested', 'assigned', 'dispatched', 'received', 'completed'] as const;
export type SupportStep = (typeof supportSteps)[number];

export const SupportPolicySchema = z.object({
  /** 担当が付かないままこの分数を過ぎた要請を「未対応」として目立たせる */
  unassignedAlertMinutes: z.number().int().positive().default(10),
  /** 手配の指示の後、届いた記録がないままこの分数を過ぎた要請を「未完了」として目立たせる */
  undeliveredAlertMinutes: z.number().int().positive().default(20),
  /** 画面に出す段階の名前 */
  stepLabels: z.partialRecord(z.enum(supportSteps), z.string().min(1)).default({}),
});

/** 搬送の段階。コードはこの id で段階を扱い、必須か省略可かは病院設定で決める */
export const transportSteps = ['requested', 'accepted', 'staffAssigned', 'ordered', 'acknowledged', 'departed', 'arrived'] as const;
export type TransportStep = (typeof transportSteps)[number];

export const TransportPolicySchema = z.object({
  /** 記録がなくても先へ進めてよい段階（未記録でも「省略可」と表示する） */
  optionalSteps: z.array(z.enum(transportSteps)).default([]),
  /** true なら到着と同時に引き渡し（所在と担当部署が同時に移る）。false なら引き渡しを別に記録する */
  handoverOnArrival: z.boolean().default(true),
  /**
   * 受け入れ了承を判断できる人。
   * location-lead: 到着先の場所の責任者（accept-transport 権限のある役職）とその代行者
   * anyone-at-location: 到着先の場所の担当者なら誰でも
   * どちらでも入力は誰でもよく、判断者と入力者を両方記録する
   */
  acceptanceDecidedBy: z.enum(['location-lead', 'anyone-at-location']).default('location-lead'),
  /** 画面に出す段階の名前。書かなかった段階は id をそのまま出す */
  stepLabels: z.partialRecord(z.enum(transportSteps), z.string().min(1)).default({}),
});

const HospitalConfigBaseSchema = z.object({
  id,
  name: z.string().min(1),
  /** 架空の病院であることを明示する。true 以外は受け付けない */
  fictional: z.literal(true),
  locations: z.array(LocationSchema).min(1),
  zones: z.array(ZoneSchema).default([]),
  zoneAssignments: z.array(ZoneAssignmentSchema).default([]),
  triageCategories: z.array(TriageCategorySchema).min(1),
  capacity: z.array(CapacitySchema).default([]),
  professions: z.array(ProfessionSchema).min(1),
  positions: z.array(PositionSchema).default([]),
  staff: z.array(StaffSchema).min(1),
  warningReasons: z.array(WarningReasonSchema).min(1),
  resources: z.array(ResourceSchema).default([]),
  checklist: z.array(ChecklistItemSchema).default([]),
  transporters: z.array(TransporterSchema).default([]),
  transporterTeams: z.array(TransporterTeamSchema).default([]),
  transportMethods: z.array(TransportMethodSchema).default([]),
  supportKinds: z.array(SupportKindSchema).default([]),
  supportPolicy: SupportPolicySchema.default({ unassignedAlertMinutes: 10, undeliveredAlertMinutes: 20, stepLabels: {} }),
  transportPolicy: TransportPolicySchema.default({ optionalSteps: [], handoverOnArrival: true, acceptanceDecidedBy: 'location-lead', stepLabels: {} }),
  /** 患者の登録で入力できる任意の識別情報。メディカルID（災害診療記録）は使わない病院が多いので既定は出さない */
  patientFields: z.object({ medicalId: z.boolean().default(false) }).default({ medicalId: false }),
  /** 確認からこの分数を過ぎた情報に「古い」印を付ける */
  staleAfterMinutes: z.number().int().positive(),
});

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

export const HospitalConfigSchema = HospitalConfigBaseSchema.superRefine((c, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  const lists = {
    locations: c.locations,
    zones: c.zones,
    triageCategories: c.triageCategories,
    professions: c.professions,
    positions: c.positions,
    staff: c.staff,
    warningReasons: c.warningReasons,
    resources: c.resources,
    checklist: c.checklist,
    transporters: c.transporters,
    transporterTeams: c.transporterTeams,
    transportMethods: c.transportMethods,
    supportKinds: c.supportKinds,
  };
  for (const [key, list] of Object.entries(lists)) {
    for (const d of duplicates(list.map((x) => x.id))) issue([key], `id「${d}」が重複している`);
  }

  const locationIds = new Set(c.locations.map((l) => l.id));
  const zoneIds = new Set(c.zones.map((z) => z.id));
  const triageIds = new Set(c.triageCategories.map((t) => t.id));
  const professionIds = new Set(c.professions.map((p) => p.id));
  const transporterIds = new Set(c.transporters.map((t) => t.id));
  c.transporterTeams.forEach((t, i) =>
    t.members.forEach((m, j) => {
      if (!transporterIds.has(m)) issue(['transporterTeams', i, 'members', j], `搬送要員「${m}」が transporters にない`);
    }),
  );
  if (c.transportPolicy.optionalSteps.some((s) => s === 'requested' || s === 'arrived'))
    issue(['transportPolicy', 'optionalSteps'], '要請と到着は省略可にできない');

  c.zones.forEach((z, i) =>
    z.triage.forEach((t, j) => {
      if (!triageIds.has(t)) issue(['zones', i, 'triage', j], `トリアージ区分「${t}」が triageCategories にない`);
    }),
  );
  c.zoneAssignments.forEach((a, i) => {
    if (!zoneIds.has(a.zoneId)) issue(['zoneAssignments', i, 'zoneId'], `ゾーン「${a.zoneId}」が zones にない`);
    if (!locationIds.has(a.locationId))
      issue(['zoneAssignments', i, 'locationId'], `場所「${a.locationId}」が locations にない`);
  });
  c.capacity.forEach((cap, i) => {
    if (!locationIds.has(cap.locationId)) issue(['capacity', i, 'locationId'], `場所「${cap.locationId}」が locations にない`);
    if (!triageIds.has(cap.triage)) issue(['capacity', i, 'triage'], `トリアージ区分「${cap.triage}」が triageCategories にない`);
  });
  c.positions.forEach((p, i) => {
    if (p.locationId && !locationIds.has(p.locationId))
      issue(['positions', i, 'locationId'], `場所「${p.locationId}」が locations にない`);
  });
  c.staff.forEach((s, i) => {
    if (!professionIds.has(s.professionId))
      issue(['staff', i, 'professionId'], `職種「${s.professionId}」が professions にない`);
    if (s.locationId && !locationIds.has(s.locationId))
      issue(['staff', i, 'locationId'], `場所「${s.locationId}」が locations にない`);
  });
});

export type HospitalConfig = z.infer<typeof HospitalConfigSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type TriageCategory = z.infer<typeof TriageCategorySchema>;
export type Staff = z.infer<typeof StaffSchema>;
export type Transporter = z.infer<typeof TransporterSchema>;

export type ConfigParseResult =
  | { ok: true; config: HospitalConfig }
  | { ok: false; errors: string[] };

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(全体)'}: ${i.message}`);
}

export function parseHospitalConfig(yamlText: string): ConfigParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, errors: [`YAML として読めない: ${(e as Error).message}`] };
  }
  const result = HospitalConfigSchema.safeParse(raw);
  return result.success ? { ok: true, config: result.data } : { ok: false, errors: formatIssues(result.error) };
}

/** 指定時刻に、その場所に割り当てられているゾーン */
export function zonesForLocation(config: HospitalConfig, locationId: string, at: string): string[] {
  const t = Date.parse(at);
  return config.zoneAssignments
    .filter((a) => a.locationId === locationId && (a.from === null || Date.parse(a.from) <= t) && (a.until === null || t < Date.parse(a.until)))
    .map((a) => a.zoneId);
}
