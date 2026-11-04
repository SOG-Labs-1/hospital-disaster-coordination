import { beforeEach, describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput } from './commands';
import type { DomainEvent } from './events';
import type { Proposal } from './proposals';
import { ScenarioSchema, type Scenario } from './scenario';
import { advance, buildRoleContext, reduceSim, resolveProposals, simMsAt, type SimEvent, type SimEventInput } from './simulator';
import { reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };

function scenario(overrides: Record<string, unknown> = {}): Scenario {
  return ScenarioSchema.parse({
    id: 'sim-test',
    title: 'テスト',
    hospital: 'test',
    fictional: true,
    durationMinutes: 10,
    roles: [
      { locationId: 'loc-a', name: '場所Aの人' },
      { locationId: 'loc-b', name: '場所Bの人' },
    ],
    initial: [{ locationId: 'loc-b', accepting: true, capacity: [{ triage: 't1', value: 1 }] }],
    settings: { responseDelaySeconds: 10, travelMinutes: 2, supportDeliveryMinutes: 3 },
    timeline: [
      { type: 'patientArrives', at: '00:30', locationId: 'loc-a', patient: { key: 'p1', tagNumber: '1', triage: 't1', features: '青い服' } },
      { type: 'patientArrives', at: '01:00', locationId: 'loc-a', patient: { key: 'p2', tagNumber: '1', triage: 't2', features: '赤い服' } },
      { type: 'supportNeed', at: '02:00', locationId: 'loc-b', kindId: 'k-staff', items: [{ professionId: 'nurse', quantity: 1 }] },
    ],
    ...overrides,
  });
}

/** 訓練の1回分を、時計を進めながら動かすための道具 */
class Run {
  sim: SimEvent[] = [];
  board: DomainEvent[] = [];
  wall = Date.parse('2026-11-04T10:00:00+09:00');
  private n = 0;
  constructor(public sc: Scenario) {
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
    const r = advance({ scenario: this.sc, config, simEvents: this.sim, boardEvents: this.board, now: new Date(this.wall) });
    this.add(r.events);
    return r.dispatch;
  }
  propose(stimulusId: string, ...proposals: (Proposal | null)[]) {
    this.add(resolveProposals(this.sim, this.sc, config, stimulusId, proposals, new Date(this.wall)));
  }
  view() {
    return reduceSim(this.sim, this.sc, config);
  }
  stimulus(id: string) {
    return this.view().stimuli.get(id)!;
  }
  /** 参加者がボードに記録する（訓練の記録） */
  boardSend(env: (b: DomainEvent[]) => CommandEnvelopeInput) {
    const r = decide(reduce(this.board), config, env(this.board), { mode: 'training', now: new Date(this.wall).toISOString(), newId: () => `B${this.board.length + 1}` });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    this.board.push(...r.events);
  }
}

let run: Run;
beforeEach(() => {
  run = new Run(scenario());
});

describe('時間とシナリオの出来事', () => {
  it('出来事は時刻が来たら起き、部署役への刺激は返事の時間の後に渡される', () => {
    expect(run.tick(29_000)).toEqual([]);
    expect(run.view().patients.p1).toBeUndefined();
    expect(run.tick(1_000)).toEqual([]);
    expect(run.view().patients.p1).toMatchObject({ locationId: 'loc-a', tagNumber: '1' });
    const dispatched = run.tick(10_000);
    expect(dispatched).toHaveLength(1);
    expect(run.stimulus(dispatched[0]!)).toMatchObject({ role: 'loc-a', stimulus: { kind: 'patientArrived', patient: { key: 'p1' } } });
  });

  it('一時停止中は時間が進まず、2倍速では2倍で進む', () => {
    run.tick(10_000);
    run.add([{ type: 'ClockChanged', running: false, speed: 1 }]);
    run.wall += 60_000;
    expect(simMsAt(run.view(), new Date(run.wall))).toBe(10_000);
    run.add([{ type: 'ClockChanged', running: true, speed: 2 }]);
    run.wall += 5_000;
    expect(simMsAt(run.view(), new Date(run.wall))).toBe(20_000);
  });

  it('シナリオの時間が終わると終了する', () => {
    run.tick(10 * 60_000);
    expect(run.view().ended).toEqual({ simMs: 600_000, reason: 'time' });
    expect(run.tick(10_000)).toEqual([]);
  });
});

describe('提案の検証', () => {
  it('部署役の返事は本部への連絡として届き、ボードは変わらない', () => {
    run.tick(30_000);
    const [s] = run.tick(10_000);
    run.propose(s!, { action: 'reply_message', message: '場所Aです。タッグ1の患者が来ました' });
    expect(run.view().inbox).toMatchObject([{ messageId: 'R-001', from: 'loc-a', text: '場所Aです。タッグ1の患者が来ました', heard: false }]);
    expect(run.board).toHaveLength(0);
  });

  it('形が正しくない提案は却下として残り、連絡は届かない', () => {
    run.tick(30_000);
    const [s] = run.tick(10_000);
    run.propose(s!, null);
    expect(run.view().proposals[0]).toMatchObject({ accepted: false, reason: '提案の形が正しくない' });
    expect(run.view().inbox).toHaveLength(0);
  });

  it('実際の状態と違う報告は却下する', () => {
    run.tick(30_000);
    const [s] = run.tick(10_000);
    run.propose(s!, { action: 'report_status', message: 'x', accepting: false, capacity: [] });
    expect(run.view().proposals[0]).toMatchObject({ accepted: false, reason: '受け入れ可否が実際の状態と違う' });
  });

  it('必要のない支援の要請は却下し、必要が起きた部署からの要請は受け付ける', () => {
    run.tick(30_000);
    const [s] = run.tick(10_000);
    run.propose(s!, { action: 'request_support', message: '人を送って' });
    expect(run.view().proposals[0]!.accepted).toBe(false);
    run.tick(2 * 60_000);
    const need = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'needSupport')![0];
    run.tick(10_000);
    run.propose(need, { action: 'request_support', message: '看護師を1人お願いします' });
    expect(run.view().proposals.at(-1)!.accepted).toBe(true);
    expect(run.view().needs[0]!.requested).toBe(true);
  });
});

describe('ボードを見て部署役に知らせる', () => {
  function registerAndRequest() {
    run.tick(60_000); // p1, p2 が到着
    run.boardSend(() => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', tagNumber: '1', triage: 't1' } }, meta }));
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    run.tick(0);
  }

  it('参加者が記録した搬送の依頼が、到着先の部署役に届く。同じタッグ番号は区分で見分ける', () => {
    registerAndRequest();
    const v = run.view();
    expect(v.transports['T-001']).toMatchObject({ patientKey: 'p1', fromLocationId: 'loc-a', toLocationId: 'loc-b', roleAccepted: null });
    const req = [...v.stimuli.values()].find((x) => x.stimulus.kind === 'transportRequest')!;
    expect(req.role).toBe('loc-b');
    expect(req.stimulus).toMatchObject({ transportId: 'T-001', fromLocationId: 'loc-a' });
  });

  it('受け入れ枠を超える了承は却下し、枠があれば了承できる', () => {
    registerAndRequest();
    const id = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
    run.tick(10_000);
    run.propose(id, { action: 'accept_transport', transportId: 'T-999', message: 'x' });
    expect(run.view().proposals.at(-1)!.reason).toContain('来ていない');
    const id2 = id; // 同じ刺激への返事は1回だけ
    run.propose(id2, { action: 'accept_transport', transportId: 'T-001', message: 'y' });
    expect(run.view().proposals).toHaveLength(1);
  });

  it('指示 → 出発の報告 → 移動時間の後に実際に到着し、到着先の部署役に知らせる', () => {
    registerAndRequest();
    const reqId = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
    run.tick(10_000);
    run.propose(reqId, { action: 'accept_transport', transportId: 'T-001', message: '場所B、受け入れできます' });
    expect(run.view().transports['T-001']!.roleAccepted).toBe(true);

    run.boardSend((b) => ({ command: { type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: { positionId: 'hq-transport' } } }, meta, expectedVersion: versionOf(reduce(b), { kind: 'transport', id: 'T-001' }) }));
    run.tick(0);
    const ordered = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportOrdered')!;
    expect(ordered[1].role).toBe('loc-a');
    run.tick(10_000);
    run.propose(ordered[0], { action: 'report_departure', transportId: 'T-001', message: '出発しました' });
    expect(run.view().transports['T-001']!.departedSimMs).toBeDefined();

    run.tick(2 * 60_000);
    const v = run.view();
    expect(v.transports['T-001']!.arrivedSimMs).toBeDefined();
    expect(v.patients.p1!.locationId).toBe('loc-b');
    expect([...v.stimuli.values()].some((x) => x.role === 'loc-b' && x.stimulus.kind === 'patientArrivedByTransport')).toBe(true);
  });

  it('受け入れ可能人数を超える了承は却下する（実際の状態で判断）', () => {
    run = new Run(
      scenario({
        timeline: [
          { type: 'patientArrives', at: '00:10', locationId: 'loc-a', patient: { key: 'p1', tagNumber: '1', triage: 't1' } },
          { type: 'patientArrives', at: '00:20', locationId: 'loc-a', patient: { key: 'p3', tagNumber: '3', triage: 't1' } },
        ],
      }),
    );
    run.tick(30_000);
    for (const tag of ['1', '3']) run.boardSend(() => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', tagNumber: tag, triage: 't1' } }, meta }));
    for (const pid of ['P-001', 'P-002']) run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: pid, toLocationId: 'loc-b' } }, meta }));
    run.tick(10_000);
    const ids = [...run.view().stimuli].filter(([, x]) => x.stimulus.kind === 'transportRequest').map(([id]) => id);
    run.propose(ids[0]!, { action: 'accept_transport', transportId: 'T-001', message: '1人なら受け入れできます' });
    run.propose(ids[1]!, { action: 'accept_transport', transportId: 'T-002', message: 'もう1人も' });
    const [first, second] = run.view().proposals.filter((p) => p.proposal?.action === 'accept_transport');
    expect(first!.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, reason: '受け入れ可能人数を超える' });
  });
});

describe('部署役が知り得る情報だけを渡す', () => {
  it('自部署の状態と本部とのやりとりだけを含み、ほかの部署の患者は含まない', () => {
    run.tick(30_000);
    const [s] = run.tick(10_000);
    const ctx = buildRoleContext(run.view(), run.sc, config, s!);
    expect(ctx).toMatchObject({ locationId: 'loc-a', roleName: '場所Aの人' });
    expect(ctx.ownStatus.patients).toEqual(['タッグ1、区分1、青い服']);
    expect(ctx.stimulusText).toContain('患者が運ばれてきた');
    run.propose(s!, { action: 'reply_message', message: '報告します' });
    run.tick(2 * 60_000);
    const need = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'needSupport')![0];
    const b = buildRoleContext(run.view(), run.sc, config, need);
    expect(b.locationId).toBe('loc-b');
    expect(b.ownStatus.patients).toEqual([]);
    expect(b.conversation).toEqual([]);
  });
});
