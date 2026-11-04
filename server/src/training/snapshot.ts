import { findingCategories, simMsAt, type CheckResult, type Finding, type HospitalConfig, type Review, type Scenario, type SimView } from '@hdc/shared';

// 画面に渡す訓練の状態。実際の状態（truth）は訓練中には渡さない（参加者には見えない情報）。
// 振り返り（終了後）でだけ、照合の結果として見せる。

export interface TrainingSnapshot {
  serverTime: string;
  provider: string;
  scenarios: { id: string; title: string; description: string; durationMinutes: number; roles: { locationId: string; name: string }[] }[];
  run: {
    runId: string;
    scenarioId: string;
    title: string;
    running: boolean;
    speed: number;
    simMs: number;
    durationMs: number;
    ended: { simMs: number; reason: 'time' | 'manual' } | null;
    startedAt: string;
  } | null;
  /** 部署役から本部への連絡（無線の受信） */
  inbox: { messageId: string; from: string; fromName: string; text: string; simMs: number; heard: boolean }[];
  /** 本部から部署役への連絡 */
  outbox: { messageId: string; to: string; toName: string; text: string; simMs: number }[];
  /** 返事を考えている部署役の数 */
  pendingReplies: number;
  /** 振り返り（訓練が終わってから） */
  review: {
    findings: (Finding & { categoryLabel: string; note?: string; explanation?: { text: string; evidence: string[] } })[];
    checks: CheckResult[];
    explainedBy: string | null;
  } | null;
}

export function buildSnapshot(opts: { config: HospitalConfig; scenarios: Scenario[]; view: SimView | null; scenario: Scenario | undefined; provider: string; now: Date; review: Review | null }): TrainingSnapshot {
  const { config, scenarios, view, scenario, provider, now, review } = opts;
  const roleName = (id: string) => scenario?.roles.find((r) => r.locationId === id)?.name ?? config.locations.find((l) => l.id === id)?.name ?? id;
  const last = view?.clock.at(-1);
  return {
    serverTime: now.toISOString(),
    provider,
    scenarios: scenarios.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      durationMinutes: s.durationMinutes,
      roles: s.roles.map((r) => ({ locationId: r.locationId, name: r.name })),
    })),
    run:
      view && scenario && view.runId
        ? {
            runId: view.runId,
            scenarioId: scenario.id,
            title: scenario.title,
            running: !view.ended && !!last?.running,
            speed: last?.speed ?? 1,
            simMs: simMsAt(view, now),
            durationMs: scenario.durationMinutes * 60000,
            ended: view.ended,
            startedAt: view.startedAt!,
          }
        : null,
    inbox: (view?.inbox ?? []).map((m) => ({ messageId: m.messageId, from: m.from, fromName: roleName(m.from), text: m.text, simMs: m.simMs, heard: m.heard })),
    outbox: (view?.outbox ?? []).map((m) => ({ messageId: m.messageId, to: m.to, toName: roleName(m.to), text: m.text, simMs: m.simMs })),
    pendingReplies: view ? [...view.stimuli.values()].filter((s) => s.dispatched && !s.resolved).length : 0,
    review: review
      ? {
          findings: review.findings.map((f) => {
            const x = view?.explanations?.explanations.find((e) => e.findingId === f.id);
            return { ...f, categoryLabel: findingCategories[f.category], note: view?.notes[f.id], explanation: x ? { text: x.text, evidence: x.evidence } : undefined };
          }),
          checks: review.checks,
          explainedBy: view?.explanations?.provider ?? null,
        }
      : null,
  };
}
