import { z } from 'zod';

// AI部署役が出せる行動（提案）。これ以外の形は受け付けない。
// 提案はシミュレーターが検証してから反映する。部署の受け入れの判断だけは、検証を通ったものを、さらにコマンドの検証を通して到着先の端末の記録にする（sim-board.ts）。
// 医療判断（診断・トリアージ判定・治療の助言）をする行動は用意しない。

/** 本部へ無線で伝える言葉。すべての提案に付く */
const message = z.string().trim().min(1).max(200);

export const ProposalSchema = z.discriminatedUnion('action', [
  /** 本部への返事・連絡だけ */
  z.object({ action: z.literal('reply_message'), message }),
  /** 自部署の状況の報告。値はシミュレーターの実際の状態と一致しなければならない */
  z.object({
    action: z.literal('report_status'),
    message,
    accepting: z.boolean().nullable().default(null),
    capacity: z.array(z.object({ triage: z.string(), value: z.number().int().min(0) })).default([]),
  }),
  z.object({ action: z.literal('accept_transport'), transportId: z.string(), message }),
  z.object({ action: z.literal('decline_transport'), transportId: z.string(), reason: z.string().trim().min(1).max(200), message }),
  /** 自部署で起きた支援の必要を本部へ要請する */
  z.object({ action: z.literal('request_support'), message }),
  z.object({ action: z.literal('report_departure'), transportId: z.string(), message }),
  z.object({ action: z.literal('report_arrival'), transportId: z.string(), message }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalAction = Proposal['action'];

export const proposalActions = ProposalSchema.options.map((o) => o.shape.action.value) as ProposalAction[];

export const proposalLabels: Record<ProposalAction, string> = {
  reply_message: '返事',
  report_status: '状況の報告',
  accept_transport: '受け入れ了承',
  decline_transport: '受け入れの断り',
  request_support: '支援の要請',
  report_departure: '出発の報告',
  report_arrival: '到着の報告',
};

/**
 * strict tool use 用のツール定義（JSON Schema）。ProposalSchema と同じ形にする。
 * strict では additionalProperties:false と全項目の required が必要なので、省略可の項目は null を許す
 */
export const proposalTools = [
  {
    name: 'reply_message',
    description: '本部への返事・連絡だけをする。状態は変えない。',
    input_schema: { type: 'object', properties: { message: { type: 'string', description: '本部へ無線で伝える言葉（日本語、短く）' } }, required: ['message'], additionalProperties: false },
  },
  {
    name: 'report_status',
    description: '自部署の受け入れ可否・受け入れ可能人数を本部へ報告する。分かっている自部署の状態だけを報告すること。',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        accepting: { type: ['boolean', 'null'], description: '受け入れ可否。報告しないなら null' },
        capacity: {
          type: 'array',
          items: { type: 'object', properties: { triage: { type: 'string' }, value: { type: 'integer' } }, required: ['triage', 'value'], additionalProperties: false },
        },
      },
      required: ['message', 'accepting', 'capacity'],
      additionalProperties: false,
    },
  },
  {
    name: 'accept_transport',
    description: '本部から依頼された搬送の受け入れを了承する。自部署に受け入れの余裕があるときだけ。',
    input_schema: { type: 'object', properties: { transportId: { type: 'string' }, message: { type: 'string' } }, required: ['transportId', 'message'], additionalProperties: false },
  },
  {
    name: 'decline_transport',
    description: '本部から依頼された搬送の受け入れを断る。理由を必ず書く。',
    input_schema: {
      type: 'object',
      properties: { transportId: { type: 'string' }, reason: { type: 'string' }, message: { type: 'string' } },
      required: ['transportId', 'reason', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_support',
    description: '自部署で必要になった支援（人員・物品）を本部へ要請する。',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  },
  {
    name: 'report_departure',
    description: '本部の指示を受けて、患者が自部署を出発したことを報告する。',
    input_schema: { type: 'object', properties: { transportId: { type: 'string' }, message: { type: 'string' } }, required: ['transportId', 'message'], additionalProperties: false },
  },
  {
    name: 'report_arrival',
    description: '本部が依頼した搬送（T-番号）で運ばれてきた患者が自部署に到着したことを報告する。搬送の番号がない患者の到着には使わない。',
    input_schema: { type: 'object', properties: { transportId: { type: 'string' }, message: { type: 'string' } }, required: ['transportId', 'message'], additionalProperties: false },
  },
] as const;

/** ツール呼び出し（name と input）を提案に直す。形が違えば null */
export function toProposal(name: string, input: unknown): Proposal | null {
  const r = ProposalSchema.safeParse({ ...(input as object), action: name });
  return r.success ? r.data : null;
}
