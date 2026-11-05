import { decide, reasonsForWarnings, type CommandEnvelopeInput } from './commands';
import type { HospitalConfig } from './config';
import type { DomainEvent } from './events';
import type { Proposal } from './proposals';
import type { Scenario } from './scenario';
import { advance, reduceSim, resolveProposals, type SimEvent, type SimEventInput } from './simulator';
import { pendingBoardWrites } from './sim-board';
import { reduce } from './state';

// テスト用：訓練の1回分を、時計を進めながら動かす

/** 訓練の1回分を、時計を進めながら動かすための道具 */
export class Run {
  sim: SimEvent[] = [];
  board: DomainEvent[] = [];
  wall = Date.parse('2026-11-04T10:00:00+09:00');
  private n = 0;
  constructor(public sc: Scenario, public config: HospitalConfig) {
    this.add([{ type: 'RunStarted', runId: 'r1', scenarioId: sc.id, hospitalId: 'test', provider: 'test' }]);
  }
  add(events: SimEventInput[]) {
    for (const e of events) this.sim.push({ ...e, id: `X${++this.n}`, at: new Date(this.wall).toISOString() } as SimEvent);
  }
  /** シナリオの時間で ms 進めて advance する。渡された刺激の id を返す */
  tick(ms: number): string[] {
    const v = this.view();
    const speed = v.clock.at(-1)!.running ? v.clock.at(-1)!.speed : 0;
    this.wall += speed ? ms / speed : ms;
    const r = advance({ scenario: this.sc, config: this.config, simEvents: this.sim, boardEvents: this.board, now: new Date(this.wall) });
    this.add(r.events);
    this.writeBoard();
    return r.dispatch;
  }
  propose(stimulusId: string, ...proposals: (Proposal | null)[]) {
    this.add(resolveProposals(this.sim, this.sc, this.config, stimulusId, proposals, new Date(this.wall)));
    this.writeBoard();
  }
  /** 部署の端末からの記録（サーバーの進行役と同じ手順：コマンドの検証を通し、警告には理由を付ける） */
  writeBoard() {
    if (this.view().ended) return;
    for (const w of pendingBoardWrites(this.view(), this.sc, this.config, reduce(this.board))) {
      if (w.skipReason) {
        this.add([{ type: 'BoardWritten', key: w.key, ok: false, error: w.skipReason }]);
        continue;
      }
      const send = (env: CommandEnvelopeInput) => decide(reduce(this.board), this.config, env, { mode: 'training', now: new Date(this.wall).toISOString(), newId: () => `B${this.board.length + 1}` });
      let r = send(w.envelope);
      if (r.status === 'warnings' && w.overrideReason) {
        const codes = r.warnings.map((x) => x.code);
        r = send({ ...w.envelope, override: { codes, reasonId: reasonsForWarnings(this.config, codes)[0]?.id, reason: w.overrideReason } });
      }
      let declinedInstead = false;
      if (r.status === 'warnings' && w.declineInstead) {
        r = send(w.declineInstead);
        declinedInstead = r.status === 'accepted';
      }
      if (r.status === 'conflict') continue;
      if (r.status === 'accepted') this.board.push(...r.events);
      this.add([{ type: 'BoardWritten', key: w.key, ok: r.status === 'accepted', ...(r.status === 'accepted' ? {} : { error: JSON.stringify(r).slice(0, 200) }), ...(w.timelineIndex !== undefined ? { timelineIndex: w.timelineIndex } : {}), ...(w.decisionFor ? { decisionFor: w.decisionFor } : {}), ...(declinedInstead ? { declinedInstead } : {}) }]);
    }
  }
  view() {
    return reduceSim(this.sim, this.sc, this.config);
  }
  stimulus(id: string) {
    return this.view().stimuli.get(id)!;
  }
  /** 参加者がボードに記録する（訓練の記録） */
  boardSend(env: (b: DomainEvent[]) => CommandEnvelopeInput) {
    const r = decide(reduce(this.board), this.config, env(this.board), { mode: 'training', now: new Date(this.wall).toISOString(), newId: () => `B${this.board.length + 1}` });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    this.board.push(...r.events);
  }
}

