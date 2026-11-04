import { beforeEach, describe, expect, it } from 'vitest';
import { decide, remainingCapacity, type CommandEnvelopeInput, type DecideResult } from './commands';
import type { HospitalConfig } from './config';
import type { DomainEvent } from './events';
import { activeTransportsForLocation, escortsAway, incomingTransports, locationView, patientsAtLocation, reduce, transporterStatus, versionOf } from './state';
import { testConfig } from './test-fixtures';

const meta = { enteredBy: 's1', terminal: 'hq' };
const leadB = { positionId: 'lead-b' };
const hq = { positionId: 'hq-transport' };

let config: HospitalConfig;
let events: DomainEvent[];
let seq: number;
let clock: number;

beforeEach(() => {
  config = testConfig();
  events = [];
  seq = 0;
  clock = Date.parse('2026-11-04T09:00:00+09:00');
});

function send(envelope: CommandEnvelopeInput): DecideResult {
  clock += 60_000;
  const result = decide(reduce(events), config, envelope, {
    mode: 'training',
    now: new Date(clock).toISOString(),
    newId: () => `E${String(++seq).padStart(4, '0')}`,
  });
  if (result.status === 'accepted') events.push(...result.events);
  return result;
}

const state = () => reduce(events);
const v = (id: string) => versionOf(state(), { kind: 'transport', id });

function registerPatient(triage: string | null = 't1', locationId = 'loc-a') {
  return send({ command: { type: 'RegisterPatient', payload: { locationId, triage } }, meta });
}

function request(patientId = 'P-001', toLocationId = 'loc-b', extra: Partial<CommandEnvelopeInput> = {}) {
  return send({ command: { type: 'RequestTransport', payload: { patientId, toLocationId } }, meta, ...extra });
}

/** 搬送の段階を1つ進める（版番号は最新を使う） */
function stepCmd(command: Record<string, unknown>, extra: Partial<CommandEnvelopeInput> = {}) {
  const id = command.transportId as string;
  return send({ command: command as never, meta, expectedVersion: v(id), ...extra });
}

describe('搬送の要請', () => {
  it('管理番号 T-001 を発行し、出発元は患者のいまの所在になる', () => {
    registerPatient();
    expect(request().status).toBe('accepted');
    const t = state().transports['T-001']!;
    expect(t).toMatchObject({ patientId: 'P-001', fromLocationId: 'loc-a', toLocationId: 'loc-b', status: 'requested', closed: false });
  });

  it('出発元と到着先が同じ、存在しない場所・患者は受け付けない', () => {
    registerPatient();
    expect(request('P-001', 'loc-a').status).toBe('rejected');
    expect(request('P-001', 'nowhere').status).toBe('rejected');
    expect(request('P-999').status).toBe('rejected');
  });

  it('同じ患者への2件目の搬送は警告し、理由を記録すれば実行できる', () => {
    registerPatient();
    request();
    const r = request('P-001', 'hq');
    expect(r.status).toBe('warnings');
    if (r.status === 'warnings') expect(r.warnings[0]).toMatchObject({ code: 'DUPLICATE_ACTIVE_TRANSPORT', relatedTransportIds: ['T-001'] });
    const ok = request('P-001', 'hq', { override: { codes: ['DUPLICATE_ACTIVE_TRANSPORT'], reason: '行き先の再検討' } });
    expect(ok.status).toBe('accepted');
    expect(state().transports['T-002']!.overrides[0]!.reason).toBe('行き先の再検討');
  });

  it('終わった搬送とは重複しない', () => {
    registerPatient();
    request();
    stepCmd({ type: 'CancelTransport', transportId: 'T-001', payload: { reason: '不要になった' } });
    expect(request().status).toBe('accepted');
  });
});

describe('調整（依頼したこと）', () => {
  beforeEach(() => {
    registerPatient('t2');
    request();
  });

  it('受け入れ了承は到着先の責任者の判断として記録する（入力は誰でもよい）', () => {
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'lead-a' } } }).status).toBe('rejected');
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: {} } }).status).toBe('rejected');
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { ...leadB, asDeputy: true } } }).status).toBe('accepted');
    const t = state().transports['T-001']!;
    expect(t.status).toBe('accepted');
    expect(t.steps.accepted).toMatchObject({ decidedBy: { positionId: 'lead-b', asDeputy: true }, enteredBy: 's1' });
  });

  it('「場所の担当者なら誰でも」に設定すれば、その場所の職員が判断できる', () => {
    config = testConfig({ transportPolicy: { acceptanceDecidedBy: 'anyone-at-location' } });
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { staffId: 's1' } } }).status).toBe('rejected');
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { staffId: 's2' } } }).status).toBe('accepted');
  });

  it('断りと了承は後の記録が有効になる', () => {
    stepCmd({ type: 'DeclineTransport', transportId: 'T-001', payload: { decidedBy: leadB, reason: '満床' } });
    expect(state().transports['T-001']).toMatchObject({ status: 'declined', closed: true });
    stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: leadB } });
    expect(state().transports['T-001']).toMatchObject({ status: 'accepted', closed: false });
  });

  it('搬送の指示は本部の役職だけが出せる', () => {
    expect(stepCmd({ type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: leadB } }).status).toBe('rejected');
    expect(stepCmd({ type: 'OrderTransport', transportId: 'T-001', payload: { orderedBy: hq } }).status).toBe('accepted');
    expect(state().transports['T-001']!.status).toBe('ordered');
  });

  it('行き先を変えると、了承は新しい行き先について取り直す', () => {
    stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: leadB } });
    stepCmd({ type: 'RedirectTransport', transportId: 'T-001', payload: { toLocationId: 'hq', reason: '手術室が使えない' } });
    const t = state().transports['T-001']!;
    expect(t.toLocationId).toBe('hq');
    expect(t.steps.accepted).toBeUndefined();
    expect(t.redirects).toMatchObject([{ fromLocationId: 'loc-b', toLocationId: 'hq', reason: '手術室が使えない' }]);
  });

  it('古い版番号での記録は競合になる', () => {
    const r = send({ command: { type: 'RecordDeparture', transportId: 'T-001', payload: {} }, meta, expectedVersion: 0 });
    expect(r.status).toBe('conflict');
  });
});

describe('事実（起きたこと）', () => {
  beforeEach(() => {
    registerPatient();
    request();
  });

  it('調整が未記録でも出発・到着を記録できる。到着で所在と担当部署が移る', () => {
    stepCmd({ type: 'RecordDeparture', transportId: 'T-001', payload: {} });
    expect(state().transports['T-001']!.status).toBe('in-transit');
    expect(patientsAtLocation(state(), 'loc-a')).toHaveLength(0); // 出発済みの患者は元の場所に数えない
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    const s = state();
    expect(s.transports['T-001']).toMatchObject({ status: 'arrived', closed: true });
    expect(s.transports['T-001']!.steps.accepted).toBeUndefined();
    expect(s.patients['P-001']).toMatchObject({ locationId: 'loc-b', departmentLocationId: 'loc-b' });
  });

  it('出発の記録がないままの到着も記録できる', () => {
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    const t = state().transports['T-001']!;
    expect(t.steps.arrived).toBeDefined();
    expect(t.steps.departed).toBeUndefined();
  });

  it('到着後・中止後は記録を足せない。出発は二重に記録できない', () => {
    stepCmd({ type: 'RecordDeparture', transportId: 'T-001', payload: {} });
    expect(stepCmd({ type: 'RecordDeparture', transportId: 'T-001', payload: {} }).status).toBe('rejected');
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    expect(stepCmd({ type: 'CancelTransport', transportId: 'T-001', payload: { reason: 'x' } }).status).toBe('rejected');
  });

  it('到着と引き渡しを分ける病院では、到着で所在だけが移り、引き渡しで担当部署が移る', () => {
    config = testConfig({ transportPolicy: { handoverOnArrival: false } });
    expect(stepCmd({ type: 'RecordHandover', transportId: 'T-001', payload: {} }).status).toBe('rejected');
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    expect(state().patients['P-001']).toMatchObject({ locationId: 'loc-b', departmentLocationId: 'loc-a' });
    expect(stepCmd({ type: 'RecordHandover', transportId: 'T-001', payload: {} }).status).toBe('accepted');
    expect(state().patients['P-001']!.departmentLocationId).toBe('loc-b');
    expect(stepCmd({ type: 'RecordHandover', transportId: 'T-001', payload: {} }).status).toBe('rejected');
  });

  it('到着の取り消し（訂正）で所在が元に戻る', () => {
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    const arrival = events.at(-1)!;
    stepCmd({ type: 'CorrectEvent', eventId: arrival.id, payload: { reason: '別の患者の到着だった', retract: true } } as never, {
      expectedVersion: v('T-001'),
    });
    const s = state();
    expect(s.patients['P-001']!.locationId).toBe('loc-a');
    expect(s.transports['T-001']!.closed).toBe(false);
  });

  it('付き添いは出発から到着まで元の場所の人数から「不在」として数える', () => {
    request('P-001', 'hq', { override: { codes: ['DUPLICATE_ACTIVE_TRANSPORT'], reason: 't' } });
    send({ command: { type: 'CancelTransport', transportId: 'T-002', payload: { reason: 'x' } }, meta, expectedVersion: v('T-002') });
    registerPatient('t2');
    send({
      command: { type: 'RequestTransport', payload: { patientId: 'P-002', toLocationId: 'loc-b', escorts: [{ professionId: 'nurse', count: 2 }] } },
      meta,
    });
    expect(escortsAway(state(), 'loc-a')).toEqual({});
    stepCmd({ type: 'RecordDeparture', transportId: 'T-003', payload: {} });
    expect(escortsAway(state(), 'loc-a')).toEqual({ nurse: 2 });
    stepCmd({ type: 'RecordArrival', transportId: 'T-003', payload: {} });
    expect(escortsAway(state(), 'loc-a')).toEqual({});
  });
});

describe('搬送要員', () => {
  beforeEach(() => {
    registerPatient('t2');
    registerPatient('t2');
    request('P-001');
    request('P-002');
  });

  it('搬送要員の割り当ては、搬送を指示できる役職がいる端末からだけ受け付ける（部署の端末からは割り当てない）', () => {
    request();
    const r = stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1'] } }, { meta: { enteredBy: 's1', terminal: 'loc-a' } });
    expect(r).toMatchObject({ status: 'rejected', errors: ['搬送要員の割り当ては、搬送を指示できる役職がいる端末（本部など）から行う'] });
    // 本部の端末からなら割り当てられる
    expect(stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1'] } }).status).toBe('accepted');
  });

  it('状態は 待機 → 割当済 → 移動中 → 到着後は最後の到着先で待機', () => {
    expect(transporterStatus(state(), 'tr1').status).toBe('idle');
    stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1', 'tr2'], teamId: 'team1' } });
    expect(transporterStatus(state(), 'tr1')).toMatchObject({ status: 'assigned', transportId: 'T-001' });
    stepCmd({ type: 'RecordDeparture', transportId: 'T-001', payload: {} });
    expect(transporterStatus(state(), 'tr2').status).toBe('moving');
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    expect(transporterStatus(state(), 'tr1')).toEqual({ status: 'idle', lastLocationId: 'loc-b' });
  });

  it('稼働中の要員への割り当ては警告し、理由を記録すれば実行できる', () => {
    stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1'] } });
    const r = stepCmd({ type: 'AssignTransportStaff', transportId: 'T-002', payload: { transporterIds: ['tr1', 'tr3'] } });
    expect(r.status).toBe('warnings');
    if (r.status === 'warnings') expect(r.warnings[0]!.message).toContain('Test One（T-001で割当済）');
    const ok = stepCmd(
      { type: 'AssignTransportStaff', transportId: 'T-002', payload: { transporterIds: ['tr1', 'tr3'] } },
      { override: { codes: ['TRANSPORTER_BUSY'], reason: 'T-001 の後に続けて対応' } },
    );
    expect(ok.status).toBe('accepted');
  });

  it('同じ搬送への割り当て直しは警告しない', () => {
    stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1'] } });
    expect(stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1', 'tr3'] } }).status).toBe('accepted');
  });

  it('対応不可の要員への割り当ても警告する。1クリックで待機に戻せる', () => {
    send({ command: { type: 'SetTransporterAvailability', transporterId: 'tr3', payload: { available: false, note: '休憩' } }, meta, expectedVersion: 0 });
    expect(transporterStatus(state(), 'tr3').status).toBe('unavailable');
    expect(stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr3'] } }).status).toBe('warnings');
    send({ command: { type: 'SetTransporterAvailability', transporterId: 'tr3', payload: { available: true } }, meta, expectedVersion: 1 });
    expect(transporterStatus(state(), 'tr3').status).toBe('idle');
  });

  it('対応不可のまま割り当てた要員も、到着後は待機に戻る', () => {
    send({ command: { type: 'SetTransporterAvailability', transporterId: 'tr3', payload: { available: false } }, meta, expectedVersion: 0 });
    stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr3'] } }, { override: { codes: ['TRANSPORTER_BUSY'], reason: '休憩を切り上げて対応' } });
    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    expect(transporterStatus(state(), 'tr3')).toEqual({ status: 'idle', lastLocationId: 'loc-b' });
  });

  it('設定にない要員は割り当てられない', () => {
    expect(stepCmd({ type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['ghost'] } }).status).toBe('rejected');
  });
});

describe('受け入れ可能人数', () => {
  it('報告がなければ設定の初期値、報告があれば報告値を使い、超える了承を警告する', () => {
    registerPatient('t1');
    registerPatient('t1');
    request('P-001');
    request('P-002');
    // 設定の初期値は loc-b の t1 が 1人
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: leadB } }).status).toBe('accepted');
    expect(remainingCapacity(config, state(), 'loc-b', 't1')).toMatchObject({ value: 1, source: 'config', present: 0, incoming: 1, remaining: 0 });
    const r = stepCmd({ type: 'AcceptTransport', transportId: 'T-002', payload: { decidedBy: leadB } });
    expect(r.status).toBe('warnings');
    if (r.status === 'warnings') expect(r.warnings[0]!.code).toBe('CAPACITY_EXCEEDED');
    // 受け入れ側が増床を報告すれば警告しない
    send({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { capacity: [{ triage: 't1', value: 3 }] } }, meta });
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-002', payload: { decidedBy: leadB } }).status).toBe('accepted');
    expect(incomingTransports(state(), 'loc-b')).toHaveLength(2);
  });

  it('区分が未判定の患者や、受け入れ可能人数が未確認の場所では警告しない', () => {
    registerPatient(null);
    request('P-001');
    expect(stepCmd({ type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: leadB } }).status).toBe('accepted');
    send({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { capacity: [{ triage: 't1', value: null }] } }, meta });
    expect(remainingCapacity(config, state(), 'loc-b', 't1')).toMatchObject({ value: null, source: 'unknown', remaining: null });
  });
});

describe('場所の報告（未確認と0の区別）', () => {
  it('報告がない値は未確認、0 は 0 として確認時刻つきで持つ', () => {
    expect(locationView(state(), 'loc-b').accepting).toEqual({ value: null, confirmedAt: null, eventId: null });
    send({
      command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { accepting: false, capacity: [{ triage: 't1', value: 0 }] } },
      meta: { ...meta, observedAt: '2026-11-04T09:00:30+09:00' },
    });
    const loc = locationView(state(), 'loc-b');
    expect(loc.accepting).toMatchObject({ value: false, confirmedAt: '2026-11-04T09:00:30+09:00' });
    expect(loc.capacity.t1!.value).toBe(0);
    expect(loc.capacity.t2).toBeUndefined();
  });

  it('報告した項目だけを更新し、後から届いた古い確認では上書きしない', () => {
    send({ command: { type: 'ReportStaffCount', locationId: 'loc-b', payload: { counts: [{ professionId: 'nurse', value: 5 }] } }, meta: { ...meta, observedAt: '2026-11-04T09:00:50+09:00' } });
    send({ command: { type: 'ReportStaffCount', locationId: 'loc-b', payload: { counts: [{ professionId: 'nurse', value: 3 }] } }, meta: { ...meta, observedAt: '2026-11-04T09:00:10+09:00' } });
    expect(locationView(state(), 'loc-b').staff.nurse!.value).toBe(5);
    send({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { accepting: true } }, meta });
    expect(locationView(state(), 'loc-b').staff.nurse!.value).toBe(5);
  });

  it('設定にない場所・区分・職種は受け付けない', () => {
    expect(send({ command: { type: 'ReportLocationStatus', locationId: 'x', payload: {} }, meta }).status).toBe('rejected');
    expect(send({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { capacity: [{ triage: 'zz', value: 1 }] } }, meta }).status).toBe('rejected');
    expect(send({ command: { type: 'ReportStaffCount', locationId: 'loc-b', payload: { counts: [{ professionId: 'pilot', value: 1 }] } }, meta }).status).toBe('rejected');
  });
});

describe('訂正の差し替えの検証', () => {
  it('搬送・場所の記録も、差し替え後の値を病院設定で検証する', () => {
    registerPatient();
    request();
    const req = events.at(-1)!;
    const correct = (eventId: string, replacement: Record<string, unknown>, subjectId: string, kind: 'transport' | 'location' = 'transport') =>
      send({
        command: { type: 'CorrectEvent', eventId, payload: { reason: '聞き間違い', replacement } },
        meta,
        expectedVersion: versionOf(state(), { kind, id: subjectId }),
      });
    expect(correct(req.id, { toLocationId: 'nowhere' }, 'T-001').status).toBe('rejected');
    expect(correct(req.id, { methodId: 'rocket' }, 'T-001').status).toBe('rejected');
    expect(correct(req.id, { toLocationId: 'hq' }, 'T-001').status).toBe('accepted');
    expect(state().transports['T-001']!.toLocationId).toBe('hq');

    stepCmd({ type: 'RecordArrival', transportId: 'T-001', payload: {} });
    expect(correct(events.at(-1)!.id, { handover: false }, 'T-001').status).toBe('rejected');

    send({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { capacity: [{ triage: 't1', value: 2 }] } }, meta });
    expect(correct(events.at(-1)!.id, { capacity: [{ triage: 'zz', value: 2 }] }, 'loc-b', 'location').status).toBe('rejected');
  });
});

describe('部署の端末で数える「関係する搬送」', () => {
  it('出発地か到着先がその場所の、進行中の搬送だけを数える', () => {
    registerPatient('t1', 'loc-a');
    request('P-001', 'loc-b');
    expect(activeTransportsForLocation(state(), 'loc-a').map((t) => t.id)).toEqual(['T-001']);
    expect(activeTransportsForLocation(state(), 'loc-b').map((t) => t.id)).toEqual(['T-001']);
    expect(activeTransportsForLocation(state(), 'hq')).toEqual([]);
  });
});
