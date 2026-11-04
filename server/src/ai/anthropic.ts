import Anthropic from '@anthropic-ai/sdk';
import { proposalTools, toProposal, type Proposal, type RoleContext } from '@hdc/shared';
import type { AiProvider, ReviewExplainInput, ReviewExplanation } from './provider';

// Claude API の部署役。出力は strict tool use（JSON Schema で形を固定）で受け、
// 形の正しい提案だけをシミュレーターに渡す（検証と反映はシミュレーターがする）。
// API キーはサーバー側の環境変数だけで扱う（ブラウザには渡さない）。

/** messages.create だけを使う（テストで差し替えられるように） */
export interface MessagesClient {
  beta: { messages: { create: (params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.Messages.BetaMessage> } };
}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicOptions {
  /** 部署役のモデル（環境変数 ANTHROPIC_MODEL。コードには書かない） */
  model: string;
  /** 振り返りの説明文のモデル（ANTHROPIC_REVIEW_MODEL。省略時は model） */
  reviewModel: string;
  /** 部署役の考える深さ（ANTHROPIC_EFFORT。短い返事を何度も返すので既定は low） */
  effort: Effort;
}

const ROLE_SYSTEM = `あなたは病院の災害対応訓練で、ある部署の職員の役を演じます。参加者は本部の役です。
- 本部へ無線で伝える言葉は、日本語で短く（80字程度まで）、部署名から始めてください。
- 渡された「あなたの部署の状況」と「本部とのやりとり」だけを根拠にします。知らないことは知らないと言い、数字や患者を作り出さないでください。
- 行動は必ず、用意されたツールのうち1つだけを呼び出して行います。ツールの外に文章を書かないでください。
- 受け入れを了承するのは、あなたの部署に受け入れ枠と余裕があるときだけです。余裕がなければ理由を添えて断ります。
- 状況を報告するときは、あなたの部署の実際の受け入れ可否・受け入れ可能人数をそのまま伝えます。
- これは訓練です。診断、トリアージ（区分）の判定や変更の提案、治療や処置の助言は一切しません。医療的な判断を求められたら「この訓練では医療的な判断は扱いません」と返事をしてください。
- 本部の調整（搬送・受け入れ・応援の要請・状況の共有）の練習相手として、現実的で、落ち着いた口調にしてください。`;

const EXPLAIN_SYSTEM = `あなたは病院の災害対応訓練の振り返りで、記録の照合結果を参加者に分かりやすく説明する役です。
- 照合はすでにプログラムが済ませています。渡された指摘ごとに、何が起きたか・なぜ記録が大切かを2〜3文の日本語で説明してください。
- 「記録がない（実際には起きたがボードにない）」と「実施されていない」を混同しないでください。
- 根拠（evidence）には、その指摘に渡された番号だけを使ってください。番号を作らないでください。
- 参加者の補足があれば尊重し、画面の外で対応していた可能性を認めてください。責める言い方、点数や順位づけはしません。
- 診断・トリアージ判定・治療の評価や助言はしません。調整と情報共有の観点だけで説明します。
- 結果は write_explanations ツールを1回呼び出して返してください。`;

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(
    private client: MessagesClient,
    private opts: AnthropicOptions,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): AnthropicProvider {
    const model = env.ANTHROPIC_MODEL;
    if (!model) throw new Error('AI_PROVIDER=anthropic のときは ANTHROPIC_MODEL（例：claude-sonnet-5-5）を環境変数で指定する');
    const effort = (env.ANTHROPIC_EFFORT ?? 'low') as Effort;
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`ANTHROPIC_EFFORT「${effort}」は使えない`);
    // 認証情報は SDK が環境変数（ANTHROPIC_API_KEY など）から読む
    // 部署役の返事は訓練の進行を止めないよう、時間と再試行を短くする（失敗したら進行役が決まった返事で補う）
    return new AnthropicProvider(new Anthropic({ timeout: 15_000, maxRetries: 1 }), { model, reviewModel: env.ANTHROPIC_REVIEW_MODEL || model, effort });
  }

  /** 安全のための断り（refusal）は、推奨の別モデルでサーバー側がやり直す */
  private base() {
    return { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const };
  }

  async proposeForRole(ctx: RoleContext): Promise<(Proposal | null)[]> {
    const user = [
      `あなたの役：${ctx.roleName}（${ctx.locationName}）${ctx.persona ? `。${ctx.persona}` : ''}`,
      `あなたの部署の状況：${JSON.stringify(ctx.ownStatus)}`,
      `あなたの部署に関係する搬送：${JSON.stringify(ctx.transports)}`,
      `本部とのやりとり（古い順）：${JSON.stringify(ctx.conversation)}`,
      `報告に使う区分の id：${ctx.triageIds.join(', ')}`,
      `いま起きたこと：${ctx.stimulusText}`,
      'ツールを1つだけ呼び出して行動してください。',
    ].join('\n');
    const res = await this.client.beta.messages.create({
      ...this.base(),
      model: this.opts.model,
      max_tokens: 2000,
      system: ROLE_SYSTEM,
      output_config: { effort: this.opts.effort },
      // 強制の tool_choice はこのモデルでは使えないので auto にし、プロンプトで1つ呼ぶよう指示する。形は strict で固定
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      tools: proposalTools.map((t) => ({ ...t, strict: true }) as Anthropic.Beta.Messages.BetaTool),
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') return [null];
    const calls = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
    // 呼び出しがない・形が違うものは null として返し、シミュレーターが却下として記録する
    return calls.length ? calls.map((c) => toProposal(c.name, c.input)) : [null];
  }

  async explainReview(input: ReviewExplainInput): Promise<ReviewExplanation[]> {
    if (input.findings.length === 0) return [];
    const res = await this.client.beta.messages.create({
      ...this.base(),
      model: this.opts.reviewModel,
      max_tokens: 8000,
      system: EXPLAIN_SYSTEM,
      output_config: { effort: 'medium' },
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      tools: [
        {
          name: 'write_explanations',
          description: '指摘ごとの説明文を返す',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              explanations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    findingId: { type: 'string', enum: input.findings.map((f) => f.id) },
                    text: { type: 'string' },
                    evidence: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['findingId', 'text', 'evidence'],
                  additionalProperties: false,
                },
              },
            },
            required: ['explanations'],
            additionalProperties: false,
          },
        },
      ],
      messages: [{ role: 'user', content: `訓練「${input.scenarioTitle}」の照合結果です。\n${JSON.stringify(input.findings)}` }],
    });
    if (res.stop_reason === 'refusal') return [];
    const call = res.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'write_explanations');
    const out = (call?.input as { explanations?: ReviewExplanation[] } | undefined)?.explanations;
    return Array.isArray(out) ? out : [];
  }
}
