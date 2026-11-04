import type { Proposal, RoleContext } from '@hdc/shared';
import type { AiProvider, ReviewExplainInput, ReviewExplanation } from './provider';

// Claude API の部署役（次の段階で実装する）
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  static fromEnv(_env: NodeJS.ProcessEnv): AnthropicProvider {
    throw new Error('AI_PROVIDER=anthropic はまだ使えない');
  }
  async proposeForRole(_ctx: RoleContext): Promise<(Proposal | null)[]> {
    return [];
  }
  async explainReview(_input: ReviewExplainInput): Promise<ReviewExplanation[]> {
    return [];
  }
}
