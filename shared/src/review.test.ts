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
  checks: [
    { id: 'reg-p1', text: 'p1を登録', rule: { type: 'patientRegistered', patientKey: 'p1' } },
    { id: 'reg-p2', text: 'p2を登録', rule: { type: 'patientRegistered', patientKey: 'p2' } },
    { id: 'dup', text: '同じタッグを別の患者に', rule: { type: 'duplicateTagHandled', tagNumber: '1' } },
    { id: 'arrived', text: 'p1の到着を記録', rule: { type: 'transportArrived', patientKey: 'p1', toLocationId: 'loc-b' } },
    { id: 'support', text: '応援の完了', rule: { type: 'supportCompleted', fromLocationId: 'loc-b' } },
  ],
});

/** 部署役は mock と同じように、必ず返事をする（ここでは手で書く） */
function answerAll(run: Run) {
  for (const [id, st] of run.view().stimuli) {
    if (!st.dispatched || st.resolved) continue;
    const s = st.stimulus;
    if (s.kind === 'transportRequest') run.propose(id, { action: 'accept_transport', transportId: s.transportId, message: '受け入れます' });
    else if (s.kind === 'transportOrdered') run.propose(id, { action: 'report_departure', transportId: s.transportId, message: '出発しました' });
    else if (s.kind === 'patientArrivedByTransport') run.propose(id, { action: 'report_arrival', transportId: s.transportId, message: '到着しました' });
    else if (s.kind === 'needSupport') run.propose(id, { action: 'request_support', message: '看護師を1人' });
    else if (s.kind === 'statusChanged') run.propose(id, { action: 'report_status', message: '受け入れ可、区分1は2人', accepting: true, capacity: [{ triage: 't1', value: 2 }] });
    else run.propose(id, { action: 'reply_message', message: '報告します' });
  }
}

function step(run: Run, ms: number) {
  run.tick(ms);
  answerAll(run);
}

const tv = (run: Run, id: string) => versionOf(reduce(run.board), { kind: 'transport', id });

describe('振り返りの照合', () => {
  it('参加者が記録しなかったことを、「記録がない」か「実施されていない」に分けて示す', () => {
    const run = new Run(sc, config);
    step(run, 60_000);
    // 参加者は p1 だけ登録し、搬送を依頼・指示する（了承・出発・到着・場所の状況・支援要請は記録しない）
    run.boardSend(() => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', tagNumber: '1', triage: 't1', features: '青い服' } }, meta }));
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    step(run, 10_000);
    run.boardSend(() => ({ command: { type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: { positionId: 'hq-transport' } } }, meta, expectedVersion: tv(run, 'T-001') }));
    step(run, 0);
    step(run, 10_000);
    step(run, 60_000);
    step(run, 10_000);

    const review = buildReview({ scenario: sc, config, view: run.view(), boardEvents: run.board });
    const titles = review.findings.map((f) => `${f.category}|${f.kind}|${f.title}`);
    expect(review.matches).toEqual({ p1: 'P-001', p2: null });
    expect(titles).toContain('unshared|no-record|患者（タッグ1・区分2・赤い服）がボードに登録されていない');
    expect(titles).toContain('unshared|no-record|場所Bの受け入れ状況がボードに記録されていない');
    expect(titles).toContain('unassigned|no-record|場所Bからの支援要請がボードにない');
    expect(titles).toContain('unconfirmed|no-record|T-001 の指示の受領確認がない');
    expect(titles).toContain('unconfirmed|no-record|T-001 の出発がボードに記録されていない');
    expect(titles).toContain('unconfirmed|no-record|T-001 の到着がボードに記録されていない');
    expect(titles).toContain('broken-handoff|no-record|T-001 の受け入れ了承が記録されていない');
    expect(titles.some((t) => t.startsWith('unshared|no-record|「聞いた」の印のない連絡'))).toBe(true);

    // 根拠には、部署役からの連絡（R-）とボードの番号を示す
    const notRegistered = review.findings.find((f) => f.title.includes('赤い服'))!;
    expect(notRegistered.evidence.every((e) => /^R-\d+$/.test(e))).toBe(true);
    expect(notRegistered.evidence.length).toBeGreaterThan(0);

    const result = Object.fromEntries(review.checks.map((c) => [c.id, c.result]));
    expect(result).toMatchObject({ 'reg-p1': 'met', 'reg-p2': 'no-record', dup: 'not-met', arrived: 'no-record', support: 'not-met' });
    expect(review.checks.filter((c) => c.source === 'hospital').every((c) => c.result === 'self-check')).toBe(true);
  });

  it('すべて記録していれば、その観点の指摘は出ない', () => {
    const run = new Run(sc, config);
    step(run, 60_000);
    run.boardSend(() => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', tagNumber: '1', triage: 't1', features: '青い服' } }, meta }));
    run.boardSend(() => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', tagNumber: '1', triage: 't2', features: '赤い服' } }, meta, override: { codes: ['DUPLICATE_TAG_NUMBER'], reason: '特徴が違う' } }));
    run.boardSend(() => ({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { accepting: true, capacity: [{ triage: 't1', value: 2 }] } }, meta }));
    run.boardSend(() => ({ command: { type: 'RequestSupport', payload: { fromLocationId: 'loc-b', kindId: 'k-staff', items: [{ professionId: 'nurse', quantity: 1 }] } }, meta }));
    run.boardSend((b) => ({ command: { type: 'AssignSupport', supportId: 'S-001', payload: { assignee: { staffId: 's1' } } }, meta, expectedVersion: versionOf(reduce(b), { kind: 'support', id: 'S-001' }) }));
    run.boardSend(() => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }));
    step(run, 10_000);
    for (const c of [
      { type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'lead-b' } } },
      { type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1'] } },
      { type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: { positionId: 'hq-transport' } } },
      { type: 'AcknowledgeTransport', transportId: 'T-001', payload: {} },
    ])
      run.boardSend(() => ({ command: c as never, meta, expectedVersion: tv(run, 'T-001') }));
    step(run, 0);
    step(run, 10_000);
    run.boardSend(() => ({ command: { type: 'RecordDeparture', transportId: 'T-001', payload: {} }, meta, expectedVersion: tv(run, 'T-001') }));
    step(run, 60_000);
    step(run, 10_000);
    run.boardSend(() => ({ command: { type: 'RecordArrival', transportId: 'T-001', payload: {} }, meta, expectedVersion: tv(run, 'T-001') }));
    run.boardSend((b) => ({ command: { type: 'CompleteSupport', supportId: 'S-001', payload: {} }, meta, expectedVersion: versionOf(reduce(b), { kind: 'support', id: 'S-001' }) }));
    for (const m of run.view().inbox) run.add([{ type: 'MessageHeard', messageId: m.messageId }]);

    const review = buildReview({ scenario: sc, config, view: run.view(), boardEvents: run.board });
    expect(review.findings).toEqual([]);
    expect(review.matches).toEqual({ p1: 'P-001', p2: 'P-002' });
    const result = Object.fromEntries(review.checks.map((c) => [c.id, c.result]));
    expect(result).toMatchObject({ 'reg-p1': 'met', 'reg-p2': 'met', dup: 'met', arrived: 'met', support: 'met' });
  });
});
