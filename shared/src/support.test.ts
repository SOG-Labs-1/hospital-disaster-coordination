import { beforeEach, describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput, type DecideResult } from './commands';
import type { DomainEvent } from './events';
import { openSupports, reduce, supportAlert, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };

let events: DomainEvent[];
let seq: number;
let clock: number;

beforeEach(() => {
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
const v = (id: string) => versionOf(state(), { kind: 'support', id });
const stepCmd = (command: Record<string, unknown>) =>
  send({ command: command as never, meta, expectedVersion: v(command.supportId as string) });

function requestStaff(count = 2) {
  return send({
    command: { type: 'RequestSupport', payload: { fromLocationId: 'loc-b', kindId: 'k-staff', items: [{ professionId: 'nurse', quantity: count }] } },
    meta: { ...meta, reportedBy: { locationId: 'loc-b' } },
  });
}

describe('支援要請', () => {
  it('管理番号 S-001 を発行し、要請した場所・種類・何をを記録する', () => {
    expect(requestStaff().status).toBe('accepted');
    expect(state().supports['S-001']).toMatchObject({ fromLocationId: 'loc-b', kindId: 'k-staff', items: [{ professionId: 'nurse', quantity: 2 }], status: 'requested' });
  });

  it('種類に合わない「何を」は受け付けない', () => {
    const r = (kindId: string, item: Record<string, unknown>) =>
      send({ command: { type: 'RequestSupport', payload: { fromLocationId: 'loc-b', kindId, items: [item as never] } }, meta }).status;
    expect(r('k-staff', { resourceId: 'res1', quantity: 1 })).toBe('rejected');
    expect(r('k-supply', { resourceId: 'nothing', quantity: 1 })).toBe('rejected');
    expect(r('k-other', { quantity: 1 })).toBe('rejected');
    expect(r('k-nope', { text: 'x' })).toBe('rejected');
    expect(r('k-supply', { resourceId: 'res1', quantity: 3 })).toBe('accepted');
    expect(r('k-other', { text: '発電機の燃料' })).toBe('accepted');
  });

  it('受付 → 手配の指示 → 届いた → 完了 の順に状態が進み、手配の既定は要請どおり・要請した場所へ', () => {
    requestStaff();
    stepCmd({ type: 'AssignSupport', supportId: 'S-001', payload: { assignee: { staffId: 's1' } } });
    expect(state().supports['S-001']!.status).toBe('assigned');
    stepCmd({ type: 'DispatchSupport', supportId: 'S-001', payload: { providerLocationId: 'loc-a' } });
    expect(state().supports['S-001']!.steps.dispatched).toMatchObject({ providerLocationId: 'loc-a', toLocationId: 'loc-b', items: [{ professionId: 'nurse', quantity: 2 }] });
    stepCmd({ type: 'RecordSupportReceived', supportId: 'S-001', payload: {} });
    expect(state().supports['S-001']!.status).toBe('received');
    stepCmd({ type: 'CompleteSupport', supportId: 'S-001', payload: {} });
    expect(state().supports['S-001']).toMatchObject({ status: 'completed', closed: true });
    expect(openSupports(state())).toHaveLength(0);
  });

  it('受付や手配が未記録でも「届いた」を記録できる', () => {
    requestStaff();
    expect(stepCmd({ type: 'RecordSupportReceived', supportId: 'S-001', payload: { note: '直接届いた' } }).status).toBe('accepted');
    const s = state().supports['S-001']!;
    expect(s.steps.assigned).toBeUndefined();
    expect(s.steps.received!.note).toBe('直接届いた');
  });

  it('完了・中止した要請には記録を足せない。受け取りは二重に記録できない', () => {
    requestStaff();
    stepCmd({ type: 'RecordSupportReceived', supportId: 'S-001', payload: {} });
    expect(stepCmd({ type: 'RecordSupportReceived', supportId: 'S-001', payload: {} }).status).toBe('rejected');
    stepCmd({ type: 'CancelSupport', supportId: 'S-001', payload: { reason: '不要になった' } });
    expect(state().supports['S-001']!.status).toBe('cancelled');
    expect(stepCmd({ type: 'CompleteSupport', supportId: 'S-001', payload: {} }).status).toBe('rejected');
  });

  it('担当者・手配先が設定にないものは受け付けない', () => {
    requestStaff();
    expect(stepCmd({ type: 'AssignSupport', supportId: 'S-001', payload: { assignee: { staffId: 'ghost' } } }).status).toBe('rejected');
    expect(stepCmd({ type: 'AssignSupport', supportId: 'S-001', payload: { assignee: {} } }).status).toBe('rejected');
    expect(stepCmd({ type: 'DispatchSupport', supportId: 'S-001', payload: { providerLocationId: 'nowhere' } }).status).toBe('rejected');
  });

  it('古い版番号での記録は競合になる', () => {
    requestStaff();
    expect(send({ command: { type: 'CompleteSupport', supportId: 'S-001', payload: {} }, meta, expectedVersion: 0 }).status).toBe('conflict');
  });
});

describe('未対応・未完了の判定', () => {
  const policy = config.supportPolicy;
  const at = (minutes: number) => new Date(Date.parse('2026-11-04T09:01:00+09:00') + minutes * 60000);

  it('担当が付かないまま一定時間が過ぎると「未対応」', () => {
    requestStaff(); // 09:01 に要請
    const s = () => state().supports['S-001']!;
    expect(supportAlert(s(), policy, at(9))).toBeNull();
    expect(supportAlert(s(), policy, at(10))).toEqual({ kind: 'unassigned', minutes: 10 });
    stepCmd({ type: 'AssignSupport', supportId: 'S-001', payload: { assignee: { name: '本部の人' } } });
    expect(supportAlert(s(), policy, at(30))).toBeNull();
  });

  it('手配の指示の後、届いた記録がないまま一定時間が過ぎると「未完了」', () => {
    requestStaff();
    stepCmd({ type: 'DispatchSupport', supportId: 'S-001', payload: { providerName: '外部の業者' } }); // 09:02
    const s = () => state().supports['S-001']!;
    expect(supportAlert(s(), policy, at(20))).toBeNull();
    expect(supportAlert(s(), policy, at(21))).toEqual({ kind: 'undelivered', minutes: 20 });
    stepCmd({ type: 'RecordSupportReceived', supportId: 'S-001', payload: {} });
    expect(supportAlert(s(), policy, at(60))).toBeNull();
  });

  it('終わった要請は目立たせない', () => {
    requestStaff();
    stepCmd({ type: 'CancelSupport', supportId: 'S-001', payload: { reason: 'x' } });
    expect(supportAlert(state().supports['S-001']!, policy, at(99))).toBeNull();
  });
});
