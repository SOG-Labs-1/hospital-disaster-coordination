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

export const PositionSchema = z.object({
  id,
  name: z.string().min(1),
  /** その役職が属する場所（本部など）。省略時は場所に縛られない */
  locationId: id.optional(),
  permissions: z.array(z.string()).default([]),
});

export const StaffSchema = z.object({
  id,
  name: z.string().min(1),
  professionId: id,
  /** 主にいる場所。入力者の一覧を端末ごとに絞り込むのに使う */
  locationId: id.optional(),
});

export const CapacitySchema = z.object({
  locationId: id,
  triage: id,
  value: z.number().int().min(0),
});

export const WarningReasonSchema = z.object({ id, label: z.string().min(1) });

export const ResourceSchema = z.object({ id, name: z.string().min(1), unit: z.string().min(1) });

export const ChecklistItemSchema = z.object({ id, text: z.string().min(1) });

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
  };
  for (const [key, list] of Object.entries(lists)) {
    for (const d of duplicates(list.map((x) => x.id))) issue([key], `id「${d}」が重複している`);
  }

  const locationIds = new Set(c.locations.map((l) => l.id));
  const zoneIds = new Set(c.zones.map((z) => z.id));
  const triageIds = new Set(c.triageCategories.map((t) => t.id));
  const professionIds = new Set(c.professions.map((p) => p.id));

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
    .filter((a) => a.locationId === locationId && (a.from === null || Date.parse(a.from) <= t))
    .map((a) => a.zoneId);
}
