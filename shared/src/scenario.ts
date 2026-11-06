import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { HospitalConfig } from './config';
import { SupportItemSchema, sexes } from './events';
import { formatIssues } from './config';

// 訓練シナリオ（scenarios/*.yaml）のスキーマ。すべて架空。
// 患者の区分（トリアージ）はシナリオの作者が書く架空の値で、AI は判定しない。
//
// 訓練は「このツールを使った訓練」：各部署は自分の端末で記録する（患者の登録・受け入れ状況・到着・支援要請は、
// シナリオのプログラムが部署の端末から記録する）。部署役（AI）が判断するのは搬送の受け入れの可否だけで、その判断も
// 部署の端末の記録として届く。無線でやりとりするのは搬送要員（transporter）だけ。

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id は英小文字・数字・ハイフンで書く');

/** 開始からの経過時刻。"mm:ss" で書く */
const at = z
  .string()
  .regex(/^\d{1,3}:[0-5]\d$/, '時刻は「分:秒」（例 02:30）で書く')
  .transform((s) => {
    const [m, sec] = s.split(':').map(Number);
    return (m! * 60 + sec!) * 1000;
  });

export const ScenarioPatientSchema = z.object({
  /** シナリオの中での呼び名（ボードの管理番号とは別） */
  key: id,
  tagNumber: z.string().optional(),
  triage: z.string(),
  sex: z.enum(sexes).default('unknown'),
  estimatedAge: z.string().optional(),
  features: z.string().optional(),
});
export type ScenarioPatient = z.infer<typeof ScenarioPatientSchema>;

const capacityList = z.array(z.object({ triage: z.string(), value: z.number().int().min(0) }));

export const TimelineEventSchema = z.discriminatedUnion('type', [
  /** 患者がその場所に着いた。その場所の端末から患者を登録する（シナリオのプログラムが記録する） */
  z.object({ type: z.literal('patientArrives'), at, locationId: z.string(), patient: ScenarioPatientSchema }),
  /** 場所の受け入れ状況が変わった（実際の状態）。その場所の端末から院内の状況に記録する */
  z.object({
    type: z.literal('locationStatus'),
    at,
    locationId: z.string(),
    accepting: z.boolean().optional(),
    capacity: capacityList.optional(),
    note: z.string().optional(),
  }),
  /** 部署で支援が必要になった。その部署の端末から支援要請を出す */
  z.object({ type: z.literal('supportNeed'), at, locationId: z.string(), kindId: z.string(), items: z.array(SupportItemSchema).min(1), note: z.string().optional() }),
  /** 経路の問題など、知らせるべき出来事。reporter が搬送要員（transporter）なら無線で、部署なら端末の連絡メモで本部へ伝える */
  z.object({ type: z.literal('notice'), at, reporter: z.string(), text: z.string().min(1) }),
]);
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/** 振り返りで照合する確認項目。照合はプログラムで行う */
export const CheckRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('patientRegistered'), patientKey: id }),
  z.object({ type: z.literal('patientAt'), patientKey: id, locationId: z.string() }),
  z.object({ type: z.literal('transportArrived'), patientKey: id, toLocationId: z.string() }),
  z.object({ type: z.literal('transportAcknowledged'), patientKey: id }),
  z.object({ type: z.literal('supportAssigned'), fromLocationId: z.string(), withinMinutes: z.number().positive() }),
  z.object({ type: z.literal('supportCompleted'), fromLocationId: z.string() }),
  z.object({ type: z.literal('locationStatusRecorded'), locationId: z.string() }),
  z.object({ type: z.literal('duplicateTagHandled'), tagNumber: z.string() }),
  /** 本部が、その患者の搬送を（決まった時間内に）依頼したか */
  z.object({ type: z.literal('transportRequested'), patientKey: id, toLocationId: z.string().optional(), withinMinutes: z.number().positive().optional() }),
  /** 本部が、搬送要員から無線で聞いた出発をボードに記録したか */
  z.object({ type: z.literal('departureRecorded'), patientKey: id }),
  /** 本部が、部署の支援要請の手配（誰がどこから送るか）を記録したか */
  z.object({ type: z.literal('supportDispatched'), fromLocationId: z.string(), withinMinutes: z.number().positive().optional() }),
]);
export type CheckRule = z.infer<typeof CheckRuleSchema>;

export const ScenarioSchema = z
  .object({
    id,
    title: z.string().min(1),
    /** 使う病院設定の id */
    hospital: id,
    fictional: z.literal(true),
    /** シナリオを作る人向けの説明（参加者には見せない。先の出来事が書いてあってよい） */
    description: z.string().default(''),
    /** 参加者に見せる説明（先の出来事は書かない） */
    briefing: z.string().default(''),
    durationMinutes: z.number().positive(),
    /** AI が担う部署役。参加者は本部 */
    roles: z.array(z.object({ locationId: z.string(), name: z.string().min(1), persona: z.string().default('') })).min(1),
    /** 搬送要員の役（AI）。本部と無線でやりとりする（本部の指示を受けて運び、出発・到着を伝える） */
    transporter: z.object({ name: z.string().min(1), persona: z.string().default('') }).optional(),
    /** 開始時の実際の状態（書かない場所は、受け入れ可・病院設定の初期値） */
    initial: z
      .array(
        z.object({
          locationId: z.string(),
          accepting: z.boolean().default(true),
          capacity: capacityList.optional(),
          staff: z.array(z.object({ professionId: z.string(), value: z.number().int().min(0) })).default([]),
        }),
      )
      .default([]),
    settings: z
      .object({
        /** 部署役が返事をするまでの時間（シナリオの時間で秒） */
        responseDelaySeconds: z.number().min(0).default(20),
        /** 出発から到着までの時間（分） */
        travelMinutes: z.number().positive().default(2),
        /** 手配の指示から支援が届くまでの時間（分） */
        supportDeliveryMinutes: z.number().positive().default(3),
        /** 部署役のいる部署の支援要請が、手配されないままこの時間（分）たつと、その部署役が端末から催促する */
        supportFollowUpMinutes: z.number().positive().default(1),
      })
      .default({ responseDelaySeconds: 20, travelMinutes: 2, supportDeliveryMinutes: 3, supportFollowUpMinutes: 1 }),
    timeline: z.array(TimelineEventSchema).min(1),
    checks: z.array(z.object({ id, text: z.string().min(1), rule: CheckRuleSchema })).default([]),
  })
  .superRefine((s, ctx) => {
    const keys = new Set<string>();
    s.timeline.forEach((e, i) => {
      if (e.type !== 'patientArrives') return;
      if (keys.has(e.patient.key)) ctx.addIssue({ code: 'custom', path: ['timeline', i, 'patient', 'key'], message: `患者の key「${e.patient.key}」が重複している` });
      keys.add(e.patient.key);
    });
    s.checks.forEach((c, i) => {
      if ('patientKey' in c.rule && !keys.has(c.rule.patientKey))
        ctx.addIssue({ code: 'custom', path: ['checks', i, 'rule', 'patientKey'], message: `患者の key「${c.rule.patientKey}」がシナリオにない` });
    });
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** シナリオが病院設定の場所・区分・職種・要請の種類を正しく指しているか */
export function checkScenarioAgainstConfig(s: Scenario, config: HospitalConfig): string[] {
  const errors: string[] = [];
  if (s.hospital !== config.id) errors.push(`hospital「${s.hospital}」と病院設定「${config.id}」が違う`);
  const loc = new Set(config.locations.map((l) => l.id));
  const tri = new Set(config.triageCategories.map((t) => t.id));
  const prof = new Set(config.professions.map((p) => p.id));
  const needLoc = (v: string, where: string) => !loc.has(v) && errors.push(`${where}：場所「${v}」が病院設定にない`);
  s.roles.forEach((r, i) => needLoc(r.locationId, `roles.${i}`));
  s.initial.forEach((x, i) => {
    needLoc(x.locationId, `initial.${i}`);
    x.capacity?.forEach((c) => !tri.has(c.triage) && errors.push(`initial.${i}：区分「${c.triage}」が病院設定にない`));
    x.staff.forEach((c) => !prof.has(c.professionId) && errors.push(`initial.${i}：職種「${c.professionId}」が病院設定にない`));
  });
  s.timeline.forEach((e, i) => {
    const w = `timeline.${i}`;
    if (e.type === 'patientArrives') {
      needLoc(e.locationId, w);
      if (!tri.has(e.patient.triage)) errors.push(`${w}：区分「${e.patient.triage}」が病院設定にない`);
    }
    if (e.type === 'locationStatus' || e.type === 'supportNeed') needLoc(e.locationId, w);
    if (e.type === 'locationStatus') e.capacity?.forEach((c) => !tri.has(c.triage) && errors.push(`${w}：区分「${c.triage}」が病院設定にない`));
    if (e.type === 'supportNeed') {
      const kind = config.supportKinds.find((k) => k.id === e.kindId);
      if (!kind) errors.push(`${w}：要請の種類「${e.kindId}」が病院設定にない`);
      for (const it of e.items) {
        if (kind?.itemSource === 'professions' && !prof.has(it.professionId ?? '')) errors.push(`${w}：職種「${it.professionId}」が病院設定にない`);
        if (kind?.itemSource === 'resources' && !config.resources.some((r) => r.id === it.resourceId)) errors.push(`${w}：物品「${it.resourceId}」が病院設定にない`);
      }
    }
    if (e.type === 'notice') {
      if (e.reporter === 'transporter' ? !s.transporter : !loc.has(e.reporter)) errors.push(`${w}：知らせる人「${e.reporter}」がいない（場所の id か、搬送要員 transporter）`);
    }
  });
  s.checks.forEach((c, i) => {
    for (const key of ['locationId', 'toLocationId', 'fromLocationId'] as const)
      if (key in c.rule) needLoc((c.rule as Record<string, string>)[key]!, `checks.${i}`);
  });
  return errors;
}

export type ScenarioParseResult = { ok: true; scenario: Scenario } | { ok: false; errors: string[] };

export function parseScenario(yamlText: string, config?: HospitalConfig): ScenarioParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, errors: [`YAML として読めない: ${(e as Error).message}`] };
  }
  const r = ScenarioSchema.safeParse(raw);
  if (!r.success) return { ok: false, errors: formatIssues(r.error) };
  if (config) {
    const errors = checkScenarioAgainstConfig(r.data, config);
    if (errors.length) return { ok: false, errors };
  }
  return { ok: true, scenario: r.data };
}
