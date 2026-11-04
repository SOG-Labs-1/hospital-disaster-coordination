import { beforeEach, describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput, type DecideResult } from './commands';
import { describeEvent } from './describe';
import type { DomainEvent } from './events';
import { activePatients, findPatientsByIdentifier, reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };
let events: DomainEvent[];
let seq: number;

beforeEach(() => {
  events = [];
  seq = 0;
});

function send(env: CommandEnvelopeInput): DecideResult {
  const r = decide(reduce(events), config, env, { mode: 'training', now: new Date(Date.parse('2026-11-04T09:00:00+09:00') + seq * 60000).toISOString(), newId: () => `E${++seq}` });
  if (r.status === 'accepted') events.push(...r.events);
  return r;
}
const pv = (id: string) => versionOf(reduce(events), { kind: 'patient', id });
const register = (payload: Record<string, unknown>) => send({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', ...payload } as never }, meta });
const correct = (id: string, fields: Record<string, unknown>, extra: Partial<CommandEnvelopeInput> = {}) =>
  send({ command: { type: 'CorrectPatientDetails', patientId: id, payload: { fields, reason: '聞き間違い' } as never }, meta, expectedVersion: pv(id), ...extra });
const merge = (target: string, source: string) => send({ command: { type: 'MergePatients', patientId: target, payload: { sourceId: source, reason: '同じ人だった' } }, meta, expectedVersion: pv(target) });

describe('登録内容の訂正', () => {
  it('書いた項目だけを直し、理由と直した項目を履歴に残す', () => {
    register({ tagNumber: '11', features: '青い服', estimatedAge: '50代' });
    expect(correct('P-001', { tagNumber: '17', features: '紺の服' }).status).toBe('accepted');
    const p = reduce(events).patients['P-001']!;
    expect(p).toMatchObject({ tagNumber: '17', features: '紺の服', estimatedAge: '50代' });
    expect(p.corrections).toMatchObject([{ reason: '聞き間違い', fields: ['tagNumber', 'features'] }]);
    expect(describeEvent(events.at(-1)!, config).text).toBe('登録内容を訂正：タッグ番号→17、特徴→紺の服（理由：聞き間違い）');
  });

  it('登録時の場所の間違いを、搬送なしで直せる（搬送中は直せない）', () => {
    register({});
    expect(correct('P-001', { locationId: 'loc-b' }).status).toBe('accepted');
    expect(reduce(events).patients['P-001']!.locationId).toBe('loc-b');
    expect(correct('P-001', { locationId: 'nowhere' }).status).toBe('rejected');
    send({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-a' } }, meta });
    send({ command: { type: 'RecordDeparture', transportId: 'T-001', payload: {} }, meta, expectedVersion: versionOf(reduce(events), { kind: 'transport', id: 'T-001' }) });
    expect(correct('P-001', { locationId: 'hq' }).status).toBe('rejected');
  });

  it('タッグ番号を直して重なるときは警告し、理由を記録すれば直せる', () => {
    register({ tagNumber: '1' });
    register({ tagNumber: '2' });
    expect(correct('P-002', { tagNumber: '1' }).status).toBe('warnings');
    expect(correct('P-002', { tagNumber: '1' }, { override: { codes: ['DUPLICATE_TAG_NUMBER'], reason: '別人を確認' } }).status).toBe('accepted');
  });

  it('直す項目がない訂正、古い版番号での訂正は受け付けない', () => {
    register({});
    expect(correct('P-001', {}).status).toBe('rejected');
    expect(correct('P-001', { features: 'x' }, { expectedVersion: 0 }).status).toBe('conflict');
  });
});

describe('患者の統合', () => {
  it('まとめられた患者は一覧から外れ、まとめ先の空いた項目を埋める。記録は消さない', () => {
    register({ tagNumber: '1', features: '青い服' });
    register({ hospitalPatientId: 'H-9', estimatedAge: '70代', sex: 'female' });
    expect(merge('P-001', 'P-002').status).toBe('accepted');
    const s = reduce(events);
    expect(activePatients(s).map((p) => p.id)).toEqual(['P-001']);
    expect(s.patients['P-002']).toMatchObject({ mergedInto: 'P-001' });
    expect(s.patients['P-001']).toMatchObject({ tagNumber: '1', features: '青い服', hospitalPatientId: 'H-9', estimatedAge: '70代', sex: 'female', mergedFrom: ['P-002'] });
    // まとめられた患者とは重複しない
    expect(findPatientsByIdentifier(s, 'hospitalPatientId', 'H-9').map((p) => p.id)).toEqual(['P-001']);
    expect(describeEvent(events.at(-1)!, config).text).toBe('P-002 を P-001 にまとめた（同じ患者。理由：同じ人だった）');
  });

  it('自分自身・まとめ済み・進行中の搬送がある患者はまとめられない', () => {
    register({});
    register({});
    register({});
    expect(merge('P-001', 'P-001').status).toBe('rejected');
    send({ command: { type: 'RequestTransport', payload: { patientId: 'P-003', toLocationId: 'loc-b' } }, meta });
    expect(merge('P-001', 'P-003').status).toBe('rejected');
    merge('P-001', 'P-002');
    expect(merge('P-001', 'P-002').status).toBe('rejected');
    expect(send({ command: { type: 'ChangePatientTriage', patientId: 'P-002', payload: { triage: 't1' } }, meta, expectedVersion: pv('P-002') }).status).toBe('rejected');
  });

  it('統合は訂正（取り消し）で元に戻せる', () => {
    register({});
    register({});
    merge('P-001', 'P-002');
    const mergeEvent = events.at(-1)!;
    send({ command: { type: 'CorrectEvent', eventId: mergeEvent.id, payload: { reason: '別人だった', retract: true } }, meta, expectedVersion: pv('P-001') });
    expect(activePatients(reduce(events)).map((p) => p.id)).toEqual(['P-001', 'P-002']);
  });
});
