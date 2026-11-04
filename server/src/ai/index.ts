import type { AiProvider } from './provider';
import { MockProvider } from './mock';

export type { AiProvider } from './provider';

/** AI_PROVIDER=mock|anthropic で切り替える。既定は mock（API なしで動く） */
export async function createAiProvider(env: NodeJS.ProcessEnv = process.env): Promise<AiProvider> {
  const kind = env.AI_PROVIDER ?? 'mock';
  if (kind === 'mock') return new MockProvider();
  if (kind === 'anthropic') {
    const { AnthropicProvider } = await import('./anthropic');
    return AnthropicProvider.fromEnv(env);
  }
  throw new Error(`AI_PROVIDER「${kind}」は使えない（mock か anthropic）`);
}
