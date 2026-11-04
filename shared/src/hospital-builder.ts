import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import {
  ChecklistItemSchema,
  formatIssues,
  HospitalConfigSchema,
  locationKinds,
  permissionKeys,
  ProfessionSchema,
  ResourceSchema,
  SupportKindSchema,
  SupportPolicySchema,
  TransportMethodSchema,
  TransportPolicySchema,
  TriageCategorySchema,
  WarningReasonSchema,
  ZoneSchema,
  type HospitalConfig,
} from './config';

// 画面で病院を作るときの入力（下書き）と、それを病院設定に組み立てる処理。
// 画面で入力しない値（トリアージ区分の表示・職種・警告の理由など）は、標準の値（テンプレート）から始める。

export const locationKindLabels: Record<(typeof locationKinds)[number], string> = {
  headquarters: '本部',
  emergency: '救急外来・処置室',
  outpatient: '外来・待合',
  ward: '病棟',
  'operating-room': '手術室',
  icu: '集中治療室',
  hall: '講堂・ホール',
  rehabilitation: 'リハビリ室',
  other: 'その他',
};

const PositionTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  permissions: z.array(z.enum(permissionKeys)).min(1),
});

/** 標準の値（config/templates/hospital-defaults.yaml） */
export const HospitalTemplateSchema = z.object({
  staleAfterMinutes: z.number().int().positive(),
  triageCategories: z.array(TriageCategorySchema).min(1),
  zones: z.array(ZoneSchema).default([]),
  professions: z.array(ProfessionSchema).min(1),
  transportMethods: z.array(TransportMethodSchema).default([]),
  transportPolicy: TransportPolicySchema,
  supportKinds: z.array(SupportKindSchema).default([]),
  supportPolicy: SupportPolicySchema,
  warningReasons: z.array(WarningReasonSchema).min(1),
  resources: z.array(ResourceSchema).default([]),
  checklist: z.array(ChecklistItemSchema).default([]),
  /** 病院を作る画面で選べる役職の雛形（名前・説明・権限）。id はプログラムが付ける */
  positionTemplates: z.object({
    hqChief: PositionTemplateSchema.extend({ nameWhenAlsoTransport: z.string().min(1) }),
    hqTransport: PositionTemplateSchema,
    locationLead: PositionTemplateSchema.extend({ nameSuffix: z.string().min(1) }),
  }),
});
export type HospitalTemplate = z.infer<typeof HospitalTemplateSchema>;

export function parseHospitalTemplate(yamlText: string): { ok: true; template: HospitalTemplate } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, errors: [`YAML として読めない: ${(e as Error).message}`] };
  }
  const r = HospitalTemplateSchema.safeParse(raw);
  return r.success ? { ok: true, template: r.data } : { ok: false, errors: formatIssues(r.error) };
}

/** 画面で入力する病院の下書き。場所や職員は、並び順の番号（index）で結び付ける */
export const HospitalDraftSchema = z
  .object({
    name: z.string().trim().min(1, '病院名を書く'),
    /** このハッカソン版では、架空の病院であることを確かめてから作る（決まり1） */
    fictional: z.literal(true, '架空の病院であることを確かめる'),
    staleAfterMinutes: z.number().int().positive().optional(),
    locations: z
      .array(
        z.object({
          name: z.string().trim().min(1, '場所の名前を書く'),
          kind: z.enum(locationKinds),
          hasTerminal: z.boolean(),
          /** 区分（トリアージ区分の id）ごとの受け入れ枠 */
          capacity: z.record(z.string(), z.number().int().min(0)).default({}),
        }),
      )
      .min(1, '場所を1つ以上入れる'),
    zoneAssignments: z.array(z.object({ zoneId: z.string(), locationIndex: z.number().int().min(0) })).default([]),
    positions: z.object({
      /** 本部長（搬送の指示・支援の手配もできる） */
      hqChief: z.boolean(),
      /** 本部の搬送調整担当（いなければ本部長が兼ねる） */
      hqTransport: z.boolean(),
      /** 本部以外の場所ごとの責任者（受け入れの了承を判断する） */
      locationLeads: z.boolean(),
    }),
    staff: z
      .array(
        z.object({
          name: z.string().trim().min(2, 'フルネームで書く'),
          locationIndex: z.number().int().min(0),
          professionId: z.string(),
          staffNumber: z.string().trim().optional(),
        }),
      )
      .min(1, '入力者を1人以上入れる'),
    /** 搬送要員の呼び名（1人ずつ。任意） */
    transporters: z.array(z.string().trim().min(1)).default([]),
  })
  .superRefine((d, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    if (!d.locations.some((l) => l.kind === 'headquarters')) issue(['locations'], '本部の場所を1つ入れる');
    const names = d.locations.map((l) => l.name);
    names.forEach((n, i) => names.indexOf(n) !== i && issue(['locations', i, 'name'], `場所の名前「${n}」が重なっている`));
    d.zoneAssignments.forEach((z, i) => z.locationIndex >= d.locations.length && issue(['zoneAssignments', i], '場所が見つからない'));
    d.staff.forEach((s, i) => s.locationIndex >= d.locations.length && issue(['staff', i, 'locationIndex'], '部署が見つからない'));
  });
export type HospitalDraft = z.infer<typeof HospitalDraftSchema>;
export type HospitalDraftInput = z.input<typeof HospitalDraftSchema>;

export type BuildResult = { ok: true; config: HospitalConfig } | { ok: false; errors: string[] };

/**
 * 下書きと標準の値から病院設定を組み立て、既存の病院と同じスキーマで検証する。
 * id は英数字で自動で付ける（場所：本部は hq、ほかは loc-N。職員：st-N。搬送要員：tr-N）
 */
export function buildHospitalConfig(input: HospitalDraftInput, template: HospitalTemplate, hospitalId: string): BuildResult {
  const parsed = HospitalDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  const d = parsed.data;
  const triageIds = new Set(template.triageCategories.map((t) => t.id));
  const errors: string[] = [];

  let hqUsed = false;
  const locationIds = d.locations.map((l, i) => {
    if (l.kind === 'headquarters' && !hqUsed) {
      hqUsed = true;
      return 'hq';
    }
    return `loc-${i + 1}`;
  });
  const hqId = 'hq';
  const locations = d.locations.map((l, i) => ({ id: locationIds[i]!, name: l.name, kind: l.kind, hasTerminal: l.hasTerminal }));
  const capacity = d.locations.flatMap((l, i) =>
    Object.entries(l.capacity).flatMap(([triage, value]) => {
      if (!triageIds.has(triage)) {
        errors.push(`区分「${triage}」が標準の値にない`);
        return [];
      }
      return [{ locationId: locationIds[i]!, triage, value }];
    }),
  );
  const zoneAssignments = d.zoneAssignments.map((z) => ({ zoneId: z.zoneId, locationId: locationIds[z.locationIndex]!, from: null, until: null }));

  // 役職の名前と権限は標準の値（positionTemplates）から取る。id はプログラムが付ける
  const pt = template.positionTemplates;
  const positions = [
    ...(d.positions.hqChief
      ? [{ id: 'hq-chief', name: d.positions.hqTransport ? pt.hqChief.name : pt.hqChief.nameWhenAlsoTransport, locationId: hqId, permissions: pt.hqChief.permissions }]
      : []),
    ...(d.positions.hqTransport ? [{ id: 'hq-transport', name: pt.hqTransport.name, locationId: hqId, permissions: pt.hqTransport.permissions }] : []),
    ...(d.positions.locationLeads
      ? locations.filter((l) => l.kind !== 'headquarters').map((l) => ({ id: `lead-${l.id}`, name: `${l.name}${pt.locationLead.nameSuffix}`, locationId: l.id, permissions: pt.locationLead.permissions }))
      : []),
  ];
  if (!positions.some((p) => p.permissions.includes('direct-transport'))) {
    const directors = [pt.hqChief, pt.hqTransport].filter((p) => p.permissions.includes('direct-transport')).map((p) => p.name);
    errors.push(`搬送の指示を出せる役職（${directors.join('か')}）を1つ以上入れる`);
  }

  const staff = d.staff.map((s, i) => ({ id: `st-${i + 1}`, name: s.name, professionId: s.professionId, locationId: locationIds[s.locationIndex]!, ...(s.staffNumber ? { staffNumber: s.staffNumber } : {}) }));
  const transporters = d.transporters.map((name, i) => ({ id: `tr-${i + 1}`, name }));
  if (errors.length) return { ok: false, errors };

  const r = HospitalConfigSchema.safeParse({
    id: hospitalId,
    name: d.name,
    fictional: true,
    staleAfterMinutes: d.staleAfterMinutes ?? template.staleAfterMinutes,
    locations,
    zones: template.zones,
    zoneAssignments,
    triageCategories: template.triageCategories,
    capacity,
    professions: template.professions,
    positions,
    staff,
    warningReasons: template.warningReasons,
    resources: template.resources,
    checklist: template.checklist,
    transporters,
    transporterTeams: [],
    transportMethods: template.transportMethods,
    transportPolicy: template.transportPolicy,
    supportKinds: template.supportKinds,
    supportPolicy: template.supportPolicy,
  });
  return r.success ? { ok: true, config: r.data } : { ok: false, errors: formatIssues(r.error) };
}
