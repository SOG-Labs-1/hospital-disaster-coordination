import type { Proposal, RoleContext } from '@hdc/shared';

// AI の抽象。部署役は「提案」を返すだけで、状態（ボード・実際の状態）を直接変えない。
// このフォルダ（server/src/ai）は、記録の保存（store）・コマンド（decide）・HTTP（app）を import しない。

export interface ReviewExplainInput {
  scenarioTitle: string;
  findings: { id: string; title: string; detail: string; evidence: string[]; participantNote?: string }[];
}

export interface ReviewExplanation {
  findingId: string;
  text: string;
  /** 根拠として示す記録の番号（入力の evidence に含まれるものだけ） */
  evidence: string[];
}

export interface AiProvider {
  readonly name: string;
  /** 部署役として、刺激への提案を返す。形が正しくない提案は null として返してよい（シミュレーターが却下する） */
  proposeForRole(ctx: RoleContext): Promise<(Proposal | null)[]>;
  /** 振り返りの説明文を書く。照合はプログラムが済ませてあり、AI は説明だけを書く */
  explainReview(input: ReviewExplainInput): Promise<ReviewExplanation[]>;
}
