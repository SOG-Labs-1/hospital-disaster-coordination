import { beforeEach, describe, expect, it } from 'vitest';
import { ScenarioSchema, type Scenario } from './scenario';
import { buildRoleContext, simMsAt, TRANSPORTER_ROLE } from './simulator';
import { Run as BaseRun } from './sim-harness';
import { reduce, versionOf } from './state';

class Run extends BaseRun {
  constructor(sc: Scenario) {
    super(sc, config);
  }
}
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
    transporter: { name: '搬送の人' },
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

let run: Run;
beforeEach(() => {
  run = new Run(scenario());
});

const boardTypes = () => run.board.map((e) => `${e.type}@${e.terminal}`);
/** 本部から搬送要員へ無線で連絡する（サーバーの進行役と同じ記録） */
function radio(text: string, id = 'S-R1') {
  run.add([
    { type: 'MessageFromHQ', messageId: 'H-001', to: TRANSPORTER_ROLE, text, simMs: 0 },
    { type: 'StimulusQueued', stimulusId: id, role: TRANSPORTER_ROLE, stimulus: { kind: 'hqMessage', text }, dueSimMs: 0 },
  ]);
  run.tick(0);
  return id;
}

describe('時間とシナリオの出来事（このツールを使った訓練）', () => {
  it('患者が着くと、その部署の端末から登録される。部署役（AI）には何も渡さない', () => {
    expect(run.tick(29_000)).toEqual([]);
    // 開始時の部署の状態（受け入れ枠）は、その部署の端末から記録される
    expect(run.board.map((e) => `${e.type}@${e.terminal}`)).toEqual(['LocationStatusReported@loc-b']);
    expect(run.tick(1_000)).toEqual([]);
    expect(run.board.find((e) => e.type === 'PatientRegistered')).toMatchObject({ type: 'PatientRegistered', terminal: 'loc-a', payload: { tagNumber: '1', triage: 't1', features: '青い服', locationId: 'loc-a' } });
    expect(run.tick(10_000)).toEqual([]);
    expect(run.view().inbox).toHaveLength(0);
  });

  it('同じタッグ番号の別の患者も、部署で確かめた理由を付けて別の患者として登録される', () => {
    run.tick(60_000);
    const regs = run.board.filter((e) => e.type === 'PatientRegistered');
    expect(regs).toHaveLength(2);
    expect(regs[1]!.override?.codes).toContain('DUPLICATE_TAG_NUMBER');
    expect(regs[1]!.override?.reason).toContain('別の患者');
  });

  it('支援が必要になると、その部署の端末から支援要請が入る', () => {
    run.tick(2 * 60_000);
    expect(boardTypes()).toContain('SupportRequested@loc-b');
    expect(run.view().needs[0]!.requested).toBe(true);
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

describe('搬送：部署の判断は端末の記録として、搬送要員とは無線で', () => {
  function request() {
    run.tick(60_000); // p1, p2 が登録される（P-001, P-002）
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    run.tick(0);
    return [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
  }

  it('本部の搬送の依頼が、到着先の部署役に届く。同じタッグ番号は区分で見分ける', () => {
    request();
    const v = run.view();
    expect(v.transports['T-001']).toMatchObject({ patientKey: 'p1', fromLocationId: 'loc-a', toLocationId: 'loc-b', roleAccepted: null });
    const req = [...v.stimuli.values()].find((x) => x.stimulus.kind === 'transportRequest')!;
    expect(req.role).toBe('loc-b');
    expect(req.stimulus).toMatchObject({ transportId: 'T-001', fromLocationId: 'loc-a' });
  });

  it('部署役の了承は、到着先の端末から記録される（無線には届かない）', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '場所B、受け入れできます' });
    const accepted = run.board.find((e) => e.type === 'TransportAccepted')!;
    expect(accepted).toMatchObject({ terminal: 'loc-b', subject: { id: 'T-001' }, payload: { decidedBy: { positionId: 'lead-b' } }, reportedBy: { name: '訓練の部署役（AI）' } });
    // AI の判断だと、ボードの上でも分かる
    expect((accepted.payload as { note: string }).note).toBe('（訓練の部署役（AI））場所B、受け入れできます');
    expect(run.view().inbox).toHaveLength(0);
  });

  it('部署役の断りは、理由つきで到着先の端末から記録される', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, { action: 'decline_transport', transportId: 'T-001', reason: '準備中', message: '場所Bです。いまは受け入れできません' });
    expect(run.board.find((e) => e.type === 'TransportDeclined')).toMatchObject({ terminal: 'loc-b', payload: { reason: expect.stringContaining('準備中') } });
  });

  it('形が正しくない提案は却下として残り、何も記録しない', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, null);
    expect(run.view().proposals[0]).toMatchObject({ accepted: false, reason: '提案の形が正しくない' });
    expect(run.board.some((e) => e.type === 'TransportAccepted')).toBe(false);
  });

  it('本部の無線の指示で搬送要員が運び出し、無線で伝える → 移動の後、到着先の端末から到着が記録される', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '受け入れます' });
    const r = radio('T-001、場所Aから場所Bへお願いします');
    run.propose(r, { action: 'report_departure', transportId: 'T-001', message: '搬送です。T-001、出発しました' });
    const v = run.view();
    expect(v.transports['T-001']!.departedSimMs).toBeDefined();
    expect(v.inbox).toMatchObject([{ messageId: 'R-001', from: TRANSPORTER_ROLE, text: '搬送です。T-001、出発しました' }]);
    // 出発は、本部が無線を聞いて記録する（自動では記録しない）
    expect(run.board.some((e) => e.type === 'TransportDeparted')).toBe(false);

    run.tick(2 * 60_000);
    const after = run.view();
    expect(after.transports['T-001']!.arrivedSimMs).toBeDefined();
    expect(after.patients.p1!.locationId).toBe('loc-b');
    expect(run.board.find((e) => e.type === 'TransportArrived')).toMatchObject({ terminal: 'loc-b', subject: { id: 'T-001' } });
    expect([...after.stimuli.values()].some((x) => x.role === TRANSPORTER_ROLE && x.stimulus.kind === 'patientArrivedByTransport')).toBe(true);
  });

  it('受け入れ枠を超える了承は却下し、同じ刺激への返事は1回だけ', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, { action: 'accept_transport', transportId: 'T-999', message: 'x' });
    expect(run.view().proposals.at(-1)!.reason).toContain('来ていない');
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: 'y' });
    expect(run.view().proposals).toHaveLength(1);
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
    for (const pid of ['P-001', 'P-002']) run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: pid, toLocationId: 'loc-b' } }, meta }));
    run.tick(10_000);
    const ids = [...run.view().stimuli].filter(([, x]) => x.stimulus.kind === 'transportRequest').map(([id]) => id);
    run.propose(ids[0]!, { action: 'accept_transport', transportId: 'T-001', message: '1人なら受け入れできます' });
    run.propose(ids[1]!, { action: 'accept_transport', transportId: 'T-002', message: 'もう1人も' });
    const [first, second] = run.view().proposals.filter((p) => p.proposal?.action === 'accept_transport');
    expect(first!.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: false, reason: '受け入れ可能人数を超える' });
  });

  it('搬送要員は、到着先の了承がないまま運び出せない（本部に確かめる）', () => {
    request();
    const r = radio('T-001、お願いします');
    run.propose(r, { action: 'report_departure', transportId: 'T-001', message: '出発しました' });
    expect(run.view().proposals.at(-1)).toMatchObject({ accepted: false, reason: '到着先の受け入れの了承がまだない' });
  });

  it('医療の判断の言葉を含む了承は、記録に入らない', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '受け入れます。区分は黄に下げるべきです' });
    expect(run.view().proposals.at(-1)).toMatchObject({ accepted: false, reason: '医療的な判断を含む言葉がある' });
    expect(run.board.some((e) => e.type === 'TransportAccepted')).toBe(false);
  });

  it('部署役のいない行き先でも、本部が手で了承を記録すれば、搬送要員は運び出せる', () => {
    run = new Run(scenario({ roles: [{ locationId: 'loc-a', name: '場所Aの人' }] }));
    run.tick(60_000);
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    run.boardSend((b) => ({ command: { type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'lead-b' } } }, meta, expectedVersion: versionOf(reduce(b), { kind: 'transport', id: 'T-001' }) }));
    run.tick(0);
    expect(run.view().transports['T-001']!.roleAccepted).toBe(true);
    const r = radio('T-001、お願いします');
    run.propose(r, { action: 'report_departure', transportId: 'T-001', message: '出発しました' });
    expect(run.view().proposals.at(-1)!.accepted).toBe(true);
  });

  it('部署役の了承がボードの受け入れ可能数を超えるなら、断りとして記録する（シミュレーターも断りにそろえる）', () => {
    const id = request();
    // 本部が、場所Bの受け入れ枠を0と記録していた（シナリオの実際の枠は1）
    run.boardSend(() => ({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { accepting: true, capacity: [{ triage: 't1', value: 0 }] } }, meta }));
    run.tick(10_000);
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '受け入れます' });
    expect(run.board.some((e) => e.type === 'TransportAccepted')).toBe(false);
    expect(run.board.find((e) => e.type === 'TransportDeclined')).toMatchObject({ terminal: 'loc-b', payload: { reason: expect.stringContaining('受け入れ可能数を超える') } });
    expect(run.view().transports['T-001']!.roleAccepted).toBe(false);
  });

  it('終わった回への返事は受け付けない（振り返りに混ざらない）', () => {
    const id = request();
    run.tick(10_000);
    run.add([{ type: 'RunEnded', simMs: 80_000, reason: 'manual' }]);
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '受け入れます' });
    expect(run.view().proposals).toHaveLength(0);
    expect(run.board.some((e) => e.type === 'TransportAccepted')).toBe(false);
  });

  it('搬送要員は、到着先が断った搬送を運び出せない', () => {
    const id = request();
    run.tick(10_000);
    run.propose(id, { action: 'decline_transport', transportId: 'T-001', reason: '満床', message: '受け入れできません' });
    const r = radio('T-001、お願いします');
    run.propose(r, { action: 'report_departure', transportId: 'T-001', message: '出発しました' });
    expect(run.view().proposals.at(-1)).toMatchObject({ accepted: false, reason: '到着先が受け入れを断っている' });
  });
});

describe('支援要請：手配されないと部署役が端末から催促し、手配には返事をする', () => {
  /** 2:00 に場所B の支援要請が入り、本部のボードで観察されるまで進める。要請の番号を返す */
  function requested() {
    run.tick(2 * 60_000);
    run.tick(0);
    return reduce(run.board).supportOrder[0]!;
  }
  const followUps = () => [...run.view().stimuli].filter(([, x]) => x.stimulus.kind === 'supportFollowUp');
  function dispatch(id: string) {
    run.boardSend((b) => ({ command: { type: 'DispatchSupport', supportId: id, payload: { providerLocationId: 'loc-a' } }, meta, expectedVersion: versionOf(reduce(b), { kind: 'support', id }) }));
  }

  it('手配されないまま決まった時間（既定1分）たつと、要請した部署役に催促の刺激が1回だけ渡る', () => {
    const id = requested();
    run.tick(59_000);
    expect(followUps()).toHaveLength(0);
    run.tick(1_000);
    expect(followUps()).toHaveLength(1);
    const [sid, f] = followUps()[0]!;
    expect(f.role).toBe('loc-b');
    expect(f.stimulus).toMatchObject({ kind: 'supportFollowUp', supportId: id, assigned: false, waitedMinutes: 1 });
    expect(run.tick(10_000)).toContain(sid);
    run.tick(3 * 60_000);
    expect(followUps()).toHaveLength(1);
  });

  it('催促は、要請した部署の端末から要請に結び付けた連絡として記録され、要請のカードに出る', () => {
    const id = requested();
    run.tick(70_000);
    const [sid] = followUps()[0]!;
    run.propose(sid, { action: 'reply_message', message: '場所Bです。看護師1人の応援はまだでしょうか' });
    const msg = run.board.find((e) => e.type === 'MessageLogged')!;
    expect(msg).toMatchObject({ terminal: 'loc-b', reportedBy: { name: '訓練の部署役（AI）' }, payload: { fromLocationId: 'loc-b', relatedIds: [id], text: '（訓練の部署役（AI））場所Bです。看護師1人の応援はまだでしょうか' } });
    expect(reduce(run.board).supports[id]!.messages).toMatchObject([{ fromLocationId: 'loc-b', reportedByName: '訓練の部署役（AI）' }]);
    expect(run.view().inbox).toHaveLength(0); // 無線には届かない
  });

  it('時間までに手配すれば催促は来ず、手配への返事が部署の端末から記録される', () => {
    const id = requested();
    run.tick(30_000);
    dispatch(id);
    run.tick(0);
    const arranged = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'supportArranged')!;
    expect(arranged[1]).toMatchObject({ role: 'loc-b', stimulus: { supportId: id, providerText: '場所Aから' } });
    run.tick(2 * 60_000);
    expect(followUps()).toHaveLength(0);
    run.propose(arranged[0], { action: 'reply_message', message: '場所Bです。手配を確認しました' });
    expect(run.board.filter((e) => e.type === 'MessageLogged')).toHaveLength(1);
  });

  it('返事を待つ間に手配された催促や、要請にない数を言う催促は記録しない', () => {
    const id = requested();
    run.tick(70_000);
    const [sid] = followUps()[0]!;
    run.propose(sid, { action: 'reply_message', message: '場所Bです。看護師5人の応援をお願いします' });
    expect(run.view().proposals.at(-1)).toMatchObject({ accepted: false, reason: '言葉の中の数が要請の中身と違う' });

    const fresh = new Run(scenario());
    run = fresh;
    const id2 = requested();
    run.tick(70_000);
    const [sid2] = followUps()[0]!;
    dispatch(id2);
    run.tick(0);
    run.propose(sid2, { action: 'reply_message', message: '場所Bです。応援はまだでしょうか' });
    expect(run.view().proposals.at(-1)).toMatchObject({ accepted: false, reason: 'すでに手配されている（催促は要らない）' });
    expect(run.board.filter((e) => e.type === 'MessageLogged')).toHaveLength(0);
    expect(id).toBe(id2);
  });

  it('部署役のいない部署の要請には、催促も返事も来ない', () => {
    run = new Run(scenario({ roles: [{ locationId: 'loc-a', name: '場所Aの人' }] }));
    const id = requested();
    run.tick(2 * 60_000);
    dispatch(id);
    run.tick(0);
    expect([...run.view().stimuli.values()].filter((x) => x.stimulus.kind === 'supportFollowUp' || x.stimulus.kind === 'supportArranged')).toHaveLength(0);
  });
});

describe('部署役が知り得る情報だけを渡す', () => {
  it('部署：自部署の状態だけ。搬送要員：動いている搬送と無線のやりとりだけ', () => {
    run.tick(60_000);
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    run.tick(10_000);
    const req = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
    const b = buildRoleContext(run.view(), run.sc, config, req);
    expect(b).toMatchObject({ roleKind: 'department', locationId: 'loc-b', roleName: '場所Bの人' });
    expect(b.ownStatus.patients).toEqual([]);
    expect(b.stimulusText).toContain('端末から記録される');
    expect(b.allowedActions).toEqual(['accept_transport', 'decline_transport']);

    const r = radio('T-001 をお願いします');
    const t = buildRoleContext(run.view(), run.sc, config, r);
    expect(t).toMatchObject({ roleKind: 'transporter', locationId: TRANSPORTER_ROLE, roleName: '搬送の人' });
    expect(t.transports).toMatchObject([{ id: 'T-001', otherLocation: '場所Aから場所Bへ' }]);
    expect(t.conversation).toEqual([{ from: 'hq', text: 'T-001 をお願いします' }]);
  });
});

describe('提案の検証（点検の指摘への対応）', () => {
  const last = () => run.view().proposals.at(-1)!;

  it('どの患者か特定できない搬送は了承できない（受け入れ枠で判断できないため）', () => {
    run.tick(30_000);
    run.boardSend(() => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', triage: 't1' } }, meta }));
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-002', toLocationId: 'loc-b' } }, meta }));
    run.tick(10_000);
    const id = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '受け入れます' });
    expect(last()).toMatchObject({ accepted: false, reason: 'どの患者か特定できない' });
  });

  it('刺激に合わない行動は却下する（受け入れの依頼に、出発で答えられない）', () => {
    run.tick(30_000);
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    run.tick(10_000);
    const id = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
    run.propose(id, { action: 'report_departure', transportId: 'T-001', message: '出発しました' });
    expect(last().reason).toContain('この連絡への返事として');
  });

  it('同じ搬送への了承を繰り返せない', () => {
    run.tick(30_000);
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    run.tick(10_000);
    const id = [...run.view().stimuli].find(([, x]) => x.stimulus.kind === 'transportRequest')![0];
    run.propose(id, { action: 'accept_transport', transportId: 'T-001', message: '受け入れます' });
    run.add([{ type: 'StimulusQueued', stimulusId: 'S-Y', role: 'loc-b', stimulus: { kind: 'transportRequest', transportId: 'T-001', patientText: '', fromLocationId: 'loc-a' }, dueSimMs: 0 }]);
    run.tick(0);
    run.propose('S-Y', { action: 'accept_transport', transportId: 'T-001', message: 'もう一度受け入れます' });
    expect(last()).toMatchObject({ accepted: false, reason: 'すでに了承している' });
    expect(run.board.filter((e) => e.type === 'TransportAccepted')).toHaveLength(1);
  });

  it('医療的な判断を含む言葉は却下する（無線にも記録にも残らない）', () => {
    const r = radio('タッグ1の区分はどうしたらいい？');
    run.propose(r, { action: 'reply_message', message: 'この患者はトリアージを変更して黄にしてください' });
    expect(last()).toMatchObject({ accepted: false, reason: '医療的な判断を含む言葉がある' });
    expect(run.view().inbox).toHaveLength(0);
  });

  it('状況の報告は、言葉の中の人数も実際と合っていなければならない（場所名の数字は見ない）', () => {
    run.add([{ type: 'StimulusQueued', stimulusId: 'S-Z', role: 'loc-b', stimulus: { kind: 'statusChanged' }, dueSimMs: 0 }]);
    run.tick(0);
    run.propose('S-Z', { action: 'report_status', message: '3階です。区分1は5人まで', accepting: true, capacity: [{ triage: 't1', value: 1 }] });
    expect(last()).toMatchObject({ accepted: false, reason: '言葉の中の数字が報告した人数と違う' });
  });
});

describe('医療的な判断を含む言葉の確認（返事・断りの理由・振り返りの説明文で共通）', () => {
  it('診断・治療の指示・区分の変更を含む文を見つける', async () => {
    const { containsMedicalAdvice } = await import('./simulator');
    for (const text of [
      '呼吸が苦しそうなので処置してください',
      '区分を上げた方がよい',
      'トリアージを赤に変更',
      '赤に上げたほうがいいです',
      '黄から赤に変えるべきです',
      '区分は赤が妥当です',
      '骨折の疑いがあります',
      '止血を優先してください',
      '輸液を始めてください',
      '酸素を投与してください',
    ]) expect(containsMedicalAdvice(text), text).toBe(true);
    // 部署の連絡としてふつうの文は止めない
    for (const text of [
      'ベッドが満床のため受け入れできません',
      '救急外来です。赤の患者が1名到着しました',
      '手術室です。受け入れを了承します。準備に10分かかります',
      '処置室の受け入れ枠は残り2名です',
      '搬送要員が出発しました',
      '区分別の受け入れ枠を変えました',
      '右足から出血しています',
      '点滴中の入院患者が3名います',
      '手術を終えた患者がいるため準備に10分かかります',
      '酸素を使っている入院患者の移動に人手が要ります',
    ]) expect(containsMedicalAdvice(text), text).toBe(false);
    // 病院設定の物品の名前（輸液セット）は取り除いてから確かめる
    const config = { resources: [{ id: 'infusion-set', name: '輸液セット', unit: 'セット' }], locations: [], professions: [] } as unknown as Parameters<typeof containsMedicalAdvice>[1];
    expect(containsMedicalAdvice('輸液セットを10セット送ってください', config)).toBe(false);
    expect(containsMedicalAdvice('応援（輸液セット 10）が届きました', config)).toBe(false);
  });
});
