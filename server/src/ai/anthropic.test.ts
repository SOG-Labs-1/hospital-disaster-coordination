import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RoleContext } from '@hdc/shared';
import { AnthropicProvider, type MessagesClient } from './anthropic';

function fakeClient(reply: Partial<Anthropic.Beta.Messages.BetaMessage>) {
  const calls: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return { stop_reason: 'tool_use', content: [], ...reply } as Anthropic.Beta.Messages.BetaMessage;
        },
      },
    },
  };
  return { client, calls };
}

const ctx: RoleContext = {
  roleKind: 'department',
  locationId: 'or',
  locationName: '手術室',
  roleName: '手術室の看護師',
  persona: '慎重',
  ownStatus: { accepting: true, capacity: [{ triage: 'red', label: '赤', value: 1, present: 0 }], staff: [], patients: [] },
  transports: [{ id: 'T-001', direction: 'incoming', otherLocation: '救急外来', status: '依頼あり' }],
  conversation: [],
  stimulusId: 'S-001',
  stimulus: { kind: 'transportRequest', transportId: 'T-001', patientText: 'タッグ101、赤', fromLocationId: 'er' },
  stimulusText: '本部から搬送の受け入れ依頼が来た',
  allowedActions: ['accept_transport', 'decline_transport', 'reply_message'],
  triageIds: ['red'],
};
const opts = { model: 'model-from-env', reviewModel: 'review-model-from-env', effort: 'low' as const };

describe('Claude API の部署役', () => {
  it('提案は strict なツールで受け、モデルは環境変数から、安全上の断りはサーバー側でやり直す', async () => {
    const { client, calls } = fakeClient({ content: [{ type: 'tool_use', id: 't1', name: 'accept_transport', input: { transportId: 'T-001', message: '手術室です。受け入れできます' } } as never] });
    const r = await new AnthropicProvider(client, opts).proposeForRole(ctx);
    expect(r).toEqual([{ action: 'accept_transport', transportId: 'T-001', message: '手術室です。受け入れできます' }]);
    const p = calls[0]!;
    expect(p.model).toBe('model-from-env');
    expect(p.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(p.tools!.every((t) => (t as { strict?: boolean }).strict === true)).toBe(true);
    // この場面（搬送の受け入れ依頼）で出してよい行動のツールだけを渡す
    expect(p.tools!.map((t) => (t as { name: string }).name).sort()).toEqual(['accept_transport', 'decline_transport', 'reply_message']);
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    // 医療判断をしないことをシステムプロンプトで指示する
    expect(String(p.system)).toContain('診断、トリアージ（区分）の判定や変更の提案、治療や処置の助言は一切しません');
    expect(String(p.system)).toContain('区分や治療は担当の医療者が判断します');
  });

  it('ツールを呼ばない返事・形の違う呼び出し・安全上の断りは null（シミュレーターが却下する）', async () => {
    expect(await new AnthropicProvider(fakeClient({ content: [{ type: 'text', text: 'はい' } as never] }).client, opts).proposeForRole(ctx)).toEqual([null]);
    expect(
      await new AnthropicProvider(fakeClient({ content: [{ type: 'tool_use', id: 't', name: 'diagnose_patient', input: {} } as never] }).client, opts).proposeForRole(ctx),
    ).toEqual([null]);
    expect(await new AnthropicProvider(fakeClient({ stop_reason: 'refusal' }).client, opts).proposeForRole(ctx)).toEqual([null]);
  });

  it('振り返りの説明文は、指摘の番号に限ったツールで受ける', async () => {
    const { client, calls } = fakeClient({
      content: [{ type: 'tool_use', id: 't', name: 'write_explanations', input: { explanations: [{ findingId: 'F-01', text: '説明', evidence: ['R-001'] }] } } as never],
    });
    const r = await new AnthropicProvider(client, opts).explainReview({ scenarioTitle: 't', findings: [{ id: 'F-01', title: 'x', detail: 'y', evidence: ['R-001'] }] });
    expect(r).toEqual([{ findingId: 'F-01', text: '説明', evidence: ['R-001'] }]);
    expect(calls[0]!.model).toBe('review-model-from-env');
    const schema = (calls[0]!.tools![0] as { input_schema: any }).input_schema;
    expect(schema.properties.explanations.items.properties.findingId.enum).toEqual(['F-01']);
  });

  it('モデルを環境変数で指定しないと使えない（コードにモデル名を書かない）', () => {
    expect(() => AnthropicProvider.fromEnv({})).toThrow(/ANTHROPIC_MODEL/);
  });
});
