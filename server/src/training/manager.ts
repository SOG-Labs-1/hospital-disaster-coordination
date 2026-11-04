import {
  advance,
  buildReview,
  buildRoleContext,
  containsMedicalAdvice,
  reduceSim,
  resolveProposals,
  simMsAt,
  type DomainEvent,
  type HospitalConfig,
  type Review,
  type Scenario,
  type SimEvent,
  type SimEventInput,
  type SimView,
} from '@hdc/shared';
import type { AiProvider } from '../ai';
import { MockProvider } from '../ai/mock';
import { SimStore } from './sim-store';

// 訓練の進行。シミュレーター（shared）を時計で動かし、部署役（AiProvider）に刺激を渡し、
// 返ってきた提案をシミュレーターで検証して記録する。
// 参加者のボードは読むだけで、書き込まない（書き込めるのは参加者の操作によるコマンドだけ）。

/** ボードへの読み取り専用の入口と、訓練の回ごとのボードの切り替え */
export interface BoardAccess {
  events(): readonly DomainEvent[];
  /** 新しい回を始めるとき、その回のボード（別ファイル）に切り替える */
  switchRun(runId: string | null): void;
}

export interface TrainingDeps {
  config: HospitalConfig;
  scenarios: Scenario[];
  simStorePath: string;
  provider: AiProvider;
  board: BoardAccess;
  newId: () => string;
  now?: () => Date;
  /** 何かが変わったときに呼ぶ（画面への配信） */
  onChange?: () => void;
  /** 部署役の返事を待つ時間（ms）。過ぎたら決まった返事で補う */
  replyTimeoutMs?: number;
}

/** 時間内に終わらなければ失敗にする */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${ms}ms 以内に返事がなかった`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const NOTE_MAX = 300;

export type ControlAction = { action: 'start'; scenarioId: string } | { action: 'pause' } | { action: 'resume' } | { action: 'speed'; speed: number } | { action: 'end' };

export class TrainingManager {
  private store: SimStore;
  private runId: string | null;
  private events: SimEvent[];
  private inflight = new Set<string>();
  private now: () => Date;
  /** AI が失敗したときに補う、決まった返事 */
  private fallback = new MockProvider();

  constructor(private deps: TrainingDeps) {
    this.store = new SimStore(deps.simStorePath);
    this.now = deps.now ?? (() => new Date());
    this.runId = this.store.latestRunId();
    this.events = this.runId ? this.store.runEvents(this.runId) : [];
  }

  get currentRunId(): string | null {
    return this.runId;
  }

  get providerName(): string {
    return this.deps.provider.name;
  }

  scenario(): Scenario | undefined {
    const v = this.events.find((e) => e.type === 'RunStarted');
    return v?.type === 'RunStarted' ? this.deps.scenarios.find((s) => s.id === v.scenarioId) : undefined;
  }

  view(): SimView | null {
    const sc = this.scenario();
    return sc ? reduceSim(this.events, sc, this.deps.config) : null;
  }

  simEvents(): readonly SimEvent[] {
    return this.events;
  }

  private append(inputs: SimEventInput[]): void {
    if (!this.runId || inputs.length === 0) return;
    const at = this.now().toISOString();
    const events = inputs.map((e) => ({ ...e, id: this.deps.newId(), at }) as SimEvent);
    this.store.append(this.runId, events);
    this.events.push(...events);
  }

  /** 時計を進める。出来事を起こし、ボードを観察し、返事の時間が来た刺激を部署役に渡す */
  tick(): void {
    const sc = this.scenario();
    if (!sc) return;
    const before = this.events.length;
    const r = advance({ scenario: sc, config: this.deps.config, simEvents: this.events, boardEvents: this.deps.board.events(), now: this.now() });
    this.append(r.events);
    // 再起動などで、渡したまま返事を受け取っていない刺激があれば渡し直す
    const view = reduceSim(this.events, sc, this.deps.config);
    for (const [id, st] of view.stimuli) if (st.dispatched && !st.resolved && !this.inflight.has(id)) this.ask(id);
    if (this.events.length !== before) this.deps.onChange?.();
    this.explainOnceAfterEnd();
  }

  private ask(stimulusId: string): void {
    const sc = this.scenario();
    if (!sc) return;
    this.inflight.add(stimulusId);
    const runId = this.runId;
    const ctx = buildRoleContext(reduceSim(this.events, sc, this.deps.config), sc, this.deps.config, stimulusId);
    // AI（Claude API）が失敗・時間切れのときは、決まった返事（mock）で補い、そのことを記録する。
    // 訓練は API が止まっても続けられる（補った回数は画面に出す）
    withTimeout(this.deps.provider.proposeForRole(ctx), this.deps.replyTimeoutMs ?? 20_000)
      .then((proposals) => ({ proposals, failed: null as string | null }))
      .catch(async (err) => {
        console.error('部署役の提案を受け取れなかった。決まった返事で補う', err);
        return { proposals: await this.fallback.proposeForRole(ctx), failed: String((err as Error)?.message ?? err) };
      })
      .then(async ({ proposals, failed }) => {
        this.inflight.delete(stimulusId);
        if (this.runId !== runId) return; // 回が変わった後の返事は使わない
        if (failed) this.append([{ type: 'ProviderFailed', stimulusId, error: failed }]);
        let resolved = resolveProposals(this.events, sc, this.deps.config, stimulusId, proposals, this.now());
        // 報告するべき場面で提案がすべて却下されたら、本部に何も届かなくなるので決まった返事で補う（補ったことは記録する）
        const mustReport = ['patientArrived', 'statusChanged', 'needSupport', 'notice', 'patientArrivedByTransport', 'supportArrived'].includes(ctx.stimulus.kind);
        if (!failed && mustReport && resolved.every((e) => e.type === 'ProposalResolved' && !e.accepted)) {
          const backup = await this.fallback.proposeForRole(ctx);
          this.append([{ type: 'ProviderFailed', stimulusId, error: '提案がすべて却下されたため、決まった返事で補った' }]);
          resolved = resolveProposals(this.events, sc, this.deps.config, stimulusId, [...proposals, ...backup], this.now());
        }
        this.append(resolved);
        this.deps.onChange?.();
      });
  }

  /** 返事待ちの部署役・説明文がなくなるまで待つ（テスト用） */
  async settle(): Promise<void> {
    while (this.inflight.size || this.explaining) await new Promise((r) => setTimeout(r, 5));
  }

  /** 振り返り。訓練が終わってからだけ作る（実際の状態は訓練中の参加者には見せない） */
  review(): Review | null {
    const sc = this.scenario();
    const view = this.view();
    if (!sc || !view?.ended) return null;
    return buildReview({ scenario: sc, config: this.deps.config, view, boardEvents: this.deps.board.events() });
  }

  private explaining = false;

  /**
   * 振り返りの説明文を AI に書かせる。照合の結果（指摘と根拠）はプログラムが作り、AI は説明だけを書く。
   * 根拠は、こちらが渡した番号だけを残す（AI が作った番号は使わない）
   */
  explain(): { ok: true } | { ok: false; error: string } {
    const review = this.review();
    const sc = this.scenario();
    if (!review || !sc) return { ok: false, error: '訓練が終わってから説明を作る' };
    if (this.explaining) return { ok: true };
    this.explaining = true;
    const runId = this.runId;
    const notes = this.view()!.notes;
    const findings = review.findings.map((f) => ({ id: f.id, title: f.title, detail: f.detail, evidence: f.evidence, participantNote: notes[f.id] }));
    withTimeout(this.deps.provider.explainReview({ scenarioTitle: sc.title, findings }), (this.deps.replyTimeoutMs ?? 20_000) * 3)
      .catch((err) => {
        console.error('振り返りの説明文を受け取れなかった。前の説明文を残す', err);
        return null;
      })
      .then((explanations) => {
        this.explaining = false;
        if (this.runId !== runId) return;
        // 失敗したときは追記しない（前の説明文を残す。照合の結果は説明文がなくても見られる）
        if (!explanations) return this.deps.onChange?.();
        const byId = new Map(findings.map((f) => [f.id, f]));
        // 医療的な判断を含む説明文は捨てる（照合の結果はプログラムが出すので、説明文がなくても見られる）
        const valid = explanations
          .filter((x) => byId.has(x.findingId) && x.text.trim() && !containsMedicalAdvice(x.text))
          .map((x) => ({ findingId: x.findingId, text: x.text.trim(), evidence: x.evidence.filter((e) => byId.get(x.findingId)!.evidence.includes(e)) }));
        this.recordExplanations(valid);
      });
    return { ok: true };
  }

  control(c: ControlAction): { ok: true } | { ok: false; error: string } {
    const view = this.view();
    const sim = view ? simMsAt(view, this.now()) : 0;
    const last = view?.clock.at(-1);
    const live = view && !view.ended;
    switch (c.action) {
      case 'start': {
        if (!this.deps.scenarios.some((s) => s.id === c.scenarioId)) return { ok: false, error: `シナリオ「${c.scenarioId}」がない` };
        if (live) this.append([{ type: 'RunEnded', simMs: sim, reason: 'manual' }]);
        this.runId = this.deps.newId();
        this.events = [];
        this.inflight.clear();
        this.deps.board.switchRun(this.runId);
        this.append([{ type: 'RunStarted', runId: this.runId, scenarioId: c.scenarioId, hospitalId: this.deps.config.id, provider: this.deps.provider.name }]);
        break;
      }
      case 'pause':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        if (last!.running) this.append([{ type: 'ClockChanged', running: false, speed: last!.speed }]);
        break;
      case 'resume':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        if (!last!.running) this.append([{ type: 'ClockChanged', running: true, speed: last!.speed }]);
        break;
      case 'speed':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        if (![1, 2].includes(c.speed)) return { ok: false, error: '速さは1倍か2倍' };
        this.append([{ type: 'ClockChanged', running: last!.running, speed: c.speed }]);
        break;
      case 'end':
        if (!live) return { ok: false, error: '進行中の訓練がない' };
        this.append([{ type: 'RunEnded', simMs: sim, reason: 'manual' }]);
        break;
    }
    this.tick();
    this.deps.onChange?.();
    return { ok: true };
  }

  /** 時間切れ・終了の直後に、振り返りの説明文を一度だけ作る */
  private explainOnceAfterEnd(): void {
    const view = this.view();
    if (view?.ended && !view.explanations && !this.explaining) this.explain();
  }

  /** 本部から部署役へ連絡する（無線で伝えたことにあたる） */
  message(to: string, text: string): { ok: true } | { ok: false; error: string } {
    const sc = this.scenario();
    const view = this.view();
    if (!sc || !view || view.ended) return { ok: false, error: '進行中の訓練がない' };
    if (!sc.roles.some((r) => r.locationId === to)) return { ok: false, error: 'その場所には部署役がいない' };
    if (!text.trim()) return { ok: false, error: '内容を書く' };
    const sim = simMsAt(view, this.now());
    const n = view.outbox.length + 1;
    this.append([
      { type: 'MessageFromHQ', messageId: `H-${String(n).padStart(3, '0')}`, to, text: text.trim(), simMs: sim },
      { type: 'StimulusQueued', stimulusId: `S-H${n}`, role: to, stimulus: { kind: 'hqMessage', text: text.trim() }, dueSimMs: sim + sc.settings.responseDelaySeconds * 1000 },
    ]);
    this.deps.onChange?.();
    return { ok: true };
  }

  heard(messageId: string): { ok: true } | { ok: false; error: string } {
    const view = this.view();
    if (!view?.inbox.some((m) => m.messageId === messageId)) return { ok: false, error: 'その連絡がない' };
    this.append([{ type: 'MessageHeard', messageId }]);
    this.deps.onChange?.();
    return { ok: true };
  }

  addNote(findingId: string, note: string): { ok: true } | { ok: false; error: string } {
    if (!this.view()?.ended) return { ok: false, error: '訓練が終わってから補足する' };
    if (!this.review()?.findings.some((f) => f.id === findingId)) return { ok: false, error: 'その指摘がない' };
    if (note.trim().length > NOTE_MAX) return { ok: false, error: `補足は${NOTE_MAX}字までにする` };
    this.append([{ type: 'ReviewNoteAdded', findingId, note: note.trim() }]);
    this.deps.onChange?.();
    return { ok: true };
  }

  recordExplanations(explanations: Extract<SimEvent, { type: 'ReviewExplained' }>['explanations']): void {
    this.append([{ type: 'ReviewExplained', provider: this.deps.provider.name, explanations }]);
    this.deps.onChange?.();
  }

  close(): void {
    this.store.close();
  }
}
