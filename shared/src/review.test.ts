import { describe, expect, it } from 'vitest';
import { buildReview } from './review';
import { ScenarioSchema } from './scenario';
import { Run } from './sim-harness';
import { reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };
const sc = ScenarioSchema.parse({
  id: 'review-test',
  title: '振り返りのテスト',
  hospital: 'test',
  fictional: true,
  durationMinutes: 10,
  roles: [
    { locationId: 'loc-a', name: '場所Aの人' },
    { locationId: 'loc-b', name: '場所Bの人' },
  ],
  initial: [{ locationId: 'loc-b', accepting: true, capacity: [{ triage: 't1', value: 2 }] }],
  settings: { responseDelaySeconds: 10, travelMinutes: 1, supportDeliveryMinutes: 1 },
  timeline: [
    { type: 'patientArrives', at: '00:10', locationId: 'loc-a', patient: { key: 'p1', tagNumber: '1', triage: 't1', features: '青い服' } },
    { type: 'patientArrives', at: '00:20', locationId: 'loc-a', patient: { key: 'p2', tagNumber: '1', triage: 't2', features: '赤い服' } },
    { type: 'locationStatus', at: '00:30', locationId: 'loc-b', accepting: true, capacity: [{ triage: 't1', value: 2 }] },
    { type: 'supportNeed', at: '00:40', locationId: 'loc-b', kindId: 'k-staff', items: [{ professionId: 'nurse', quantity: 1 }] },
  ],
  transporter: { name: '搬送の人' },
  checks: [
    { id: 'request', text: 'p1の搬送を1分以内に依頼', rule: { type: 'transportRequested', patientKey: 'p1', toLocationId: 'loc-b', withinMinutes: 1 } },
    { id: 'dup', text: '同じタッグが別の患者になっている', rule: { type: 'duplicateTagHandled', tagNumber: '1' } },
    { id: 'departure', text: '出発を記録', rule: { type: 'departureRecorded', patientKey: 'p1' } },
    { id: 'arrived', text: 'p1の到着が分かる', rule: { type: 'transportArrived', patientKey: 'p1', toLocationId: 'loc-b' } },
    { id: 'dispatched', text: '応援の手配', rule: { type: 'supportDispatched', fromLocationId: 'loc-b' } },
  ],
});

/** 部署役は mock と同じように、必ず返事をする（ここでは手で書く） */
function answerAll(run: Run) {
  for (const [id, st] of run.view().stimuli) {
    if (!st.dispatched || st.resolved) continue;
    const s = st.stimulus;
    if (s.kind === 'transportRequest') run.propose(id, { action: 'accept_transport', transportId: s.transportId, message: '受け入れます' });
    else if (s.kind === 'hqMessage') run.propose(id, { action: 'report_departure', transportId: 'T-001', message: '搬送です。T-001、出発しました' });
    else if (s.kind === 'patientArrivedByTransport') run.propose(id, { action: 'report_arrival', transportId: s.transportId, message: '搬送です。到着しました' });
    else run.propose(id, { action: 'reply_message', message: '了解しました' });
  }
}

function step(run: Run, ms: number) {
  run.tick(ms);
  answerAll(run);
}

/** 本部から搬送要員へ無線で指示する */
function radio(run: Run, text: string) {
  const n = run.view().outbox.length + 1;
  run.add([
    { type: 'MessageFromHQ', messageId: `H-00${n}`, to: 'transporter', text, simMs: 0 },
    { type: 'StimulusQueued', stimulusId: `S-H${n}`, role: 'transporter', stimulus: { kind: 'hqMessage', text }, dueSimMs: 0 },
  ]);
}

const tv = (run: Run, id: string) => versionOf(reduce(run.board), { kind: 'transport', id });
const sv = (run: Run, id: string) => versionOf(reduce(run.board), { kind: 'support', id });

describe('振り返りの照合（このツールを使った訓練）', () => {
  it('本部が記録しなかったことを、「記録がない」か「実施されていない」に分けて示す', () => {
    const run = new Run(sc, config);
    step(run, 60_000); // 患者2人・受け入れ状況・支援要請は、部署の端末から記録される
    // 本部は搬送を依頼・指示し、無線で搬送要員に伝える（受領確認・出発の記録・支援の受付はしない）
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    step(run, 10_000);
    step(run, 0);
    run.boardSend(() => ({ command: { type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: { positionId: 'hq-transport' } } }, meta, expectedVersion: tv(run, 'T-001') }));
    radio(run, 'T-001、場所Bへお願いします');
    step(run, 0);
    step(run, 60_000);
    step(run, 10_000);

    const review = buildReview({ scenario: sc, config, view: run.view(), boardEvents: run.board });
    const titles = review.findings.map((f) => `${f.category}|${f.kind}|${f.title}`);
    expect(review.matches).toEqual({ p1: 'P-001', p2: 'P-002' });
    expect(titles).toContain('unconfirmed|no-record|T-001 の指示の受領確認がない');
    expect(titles).toContain('unconfirmed|no-record|T-001 の出発がボードに記録されていない');
    expect(titles).toContain('unassigned|not-done|S-001（場所B）に担当が付いていない');
    expect(titles.some((t) => t.startsWith('unshared|no-record|「聞いた」の印のない連絡'))).toBe(true);
    // 部署の端末から記録したものは、指摘に出ない
    expect(titles.some((t) => t.includes('登録されていない') || t.includes('受け入れ状況') || t.includes('支援要請がボードにない') || t.includes('到着がボードに'))).toBe(false);

    // 出発の指摘の根拠には、搬送要員の無線（R-）を示す
    const departure = review.findings.find((f) => f.title.includes('出発'))!;
    expect(departure.evidence).toContain('R-001');

    const result = Object.fromEntries(review.checks.map((c) => [c.id, c.result]));
    expect(result).toMatchObject({ request: 'met', dup: 'met', departure: 'no-record', arrived: 'met', dispatched: 'not-met' });
    expect(review.checks.filter((c) => c.source === 'hospital').every((c) => c.result === 'self-check')).toBe(true);
  });

  it('途中で終えた回では、まだ起きていない場面の確認項目を「起きなかった」と示す', () => {
    const run = new Run(sc, config);
    step(run, 15_000); // p1 だけが着いた時点で終える
    run.add([{ type: 'RunEnded', simMs: 15_000, reason: 'manual' }]);
    const result = Object.fromEntries(buildReview({ scenario: sc, config, view: run.view(), boardEvents: run.board }).checks.map((c) => [c.id, c.result]));
    expect(result).toMatchObject({ request: 'not-met', dup: 'not-reached', dispatched: 'not-reached' });
  });

  it('本部がすべて記録していれば、その観点の指摘は出ない', () => {
    const run = new Run(sc, config);
    step(run, 45_000);
    run.boardSend((b) => ({ command: { type: 'AssignSupport', supportId: 'S-001', payload: { assignee: { staffId: 's1' } } }, meta, expectedVersion: versionOf(reduce(b), { kind: 'support', id: 'S-001' }) }));
    run.boardSend(() => ({ command: { type: 'DispatchSupport', supportId: 'S-001', payload: { providerName: '外来の看護師', toLocationId: 'loc-b' } }, meta, expectedVersion: sv(run, 'S-001') }));
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    step(run, 0); // 依頼を見て、手術室の部署役に渡す
    step(run, 10_000); // 返事の時間の後、受け入れの了承が手術室の端末から記録される
    for (const c of [
      { type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1'] } },
      { type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: { positionId: 'hq-transport' } } },
      { type: 'AcknowledgeTransport', transportId: 'T-001', payload: {} },
    ])
      run.boardSend(() => ({ command: c as never, meta, expectedVersion: tv(run, 'T-001') }));
    radio(run, 'T-001、場所Bへお願いします');
    step(run, 0);
    run.boardSend(() => ({ command: { type: 'RecordDeparture', transportId: 'T-001', payload: {} }, meta, expectedVersion: tv(run, 'T-001') }));
    step(run, 60_000);
    step(run, 10_000);
    run.boardSend(() => ({ command: { type: 'CompleteSupport', supportId: 'S-001', payload: {} }, meta, expectedVersion: sv(run, 'S-001') }));
    for (const m of run.view().inbox) run.add([{ type: 'MessageHeard', messageId: m.messageId }]);

    const review = buildReview({ scenario: sc, config, view: run.view(), boardEvents: run.board });
    expect(review.findings).toEqual([]);
    const result = Object.fromEntries(review.checks.map((c) => [c.id, c.result]));
    expect(result).toMatchObject({ request: 'met', dup: 'met', departure: 'met', arrived: 'met', dispatched: 'met' });
  });
});
