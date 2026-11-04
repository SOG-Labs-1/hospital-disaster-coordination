import { beforeEach, describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput, type DecideResult } from './commands';
import { zonesForLocation } from './config';
import { describeEvent } from './describe';
import type { DomainEvent } from './events';
import { effectiveConfig, reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const base = testConfig({
  zones: [
    { id: 'z-red', name: '赤ゾーン', triage: ['t1'] },
    { id: 'z-green', name: '緑ゾーン', triage: ['t2'] },
  ],
  zoneAssignments: [{ zoneId: 'z-red', locationId: 'loc-a' }],
});
const meta = { enteredBy: 's1', terminal: 'hq' };
let events: DomainEvent[];
let clock: number;

beforeEach(() => {
  events = [];
  clock = Date.parse('2026-11-04T09:00:00+09:00');
});
function send(env: CommandEnvelopeInput): DecideResult {
  clock += 60_000;
  const r = decide(reduce(events), base, env, { mode: 'live', now: new Date(clock).toISOString(), newId: () => `E${events.length + 1}` });
  if (r.status === 'accepted') events.push(...r.events);
  return r;
}
const staff = (payload: Record<string, unknown>, enteredBy = 'self', extra: Partial<CommandEnvelopeInput> = {}) =>
  send({ command: { type: 'RegisterStaff', payload: { locationId: 'loc-b', professionId: 'nurse', ...payload } as never }, meta: { ...meta, enteredBy }, ...extra });

describe('入力者（職員）の追加', () => {
  it('追加した職員は名前の一覧に入り、入力者として記録できる。本人が自分を追加できる', () => {
    expect(staff({ name: '架空 花子', staffNumber: 'N-0012' }).status).toBe('accepted');
    const e = events[0]!;
    expect(e).toMatchObject({ subject: { kind: 'staff', id: 'ST-001' }, enteredBy: 'ST-001' });
    const cfg = effectiveConfig(base, reduce(events));
    expect(cfg.staff.at(-1)).toMatchObject({ id: 'ST-001', name: '架空 花子', locationId: 'loc-b', professionId: 'nurse', staffNumber: 'N-0012' });
    // 追加した職員を入力者にして記録できる
    expect(send({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a' } }, meta: { ...meta, enteredBy: 'ST-001' } }).status).toBe('accepted');
    expect(describeEvent(e, cfg).text).toBe('入力者を追加：架空 花子（場所B・看護師・職員番号 N-0012）');
  });

  it('フルネーム・部署・職種は必須で、設定にない部署・職種は受け付けない', () => {
    expect(staff({ name: 'あ' }).status).toBe('rejected');
    expect(staff({ name: '架空 次郎', locationId: 'nowhere' }).status).toBe('rejected');
    expect(staff({ name: '架空 次郎', professionId: 'pilot' }).status).toBe('rejected');
  });

  it('同じ職員番号、または同じ部署の同じ名前は警告し、理由を記録すれば追加できる', () => {
    staff({ name: '架空 花子', staffNumber: 'N-1' });
    expect(staff({ name: '架空 春子', staffNumber: 'Ｎ-1' }).status).toBe('warnings');
    expect(staff({ name: '架空 花子' }).status).toBe('warnings');
    expect(staff({ name: '架空 花子' }, 'self', { override: { codes: ['DUPLICATE_STAFF'], reason: '同姓同名の別人' } }).status).toBe('accepted');
  });

  it('一覧にいない人を入力者にはできない（self は入力者の追加のときだけ）', () => {
    expect(send({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a' } }, meta: { ...meta, enteredBy: 'self' } }).status).toBe('rejected');
  });

  it('間違えて追加した入力者は、訂正（取り消し）で一覧から外れる', () => {
    staff({ name: '架空 花子' });
    send({ command: { type: 'CorrectEvent', eventId: events[0]!.id, payload: { reason: '重複', retract: true } }, meta, expectedVersion: 1 });
    expect(effectiveConfig(base, reduce(events)).staff.some((s) => s.id === 'ST-001')).toBe(false);
  });
});

describe('場所の用途（ゾーン）の変更', () => {
  const zoneChange = (locationId: string, zoneIds: string[]) =>
    send({ command: { type: 'ChangeZoneAssignment', locationId, payload: { zoneIds } }, meta, expectedVersion: versionOf(reduce(events), { kind: 'location', id: locationId }) });

  it('変更した時刻からの用途が変わり、それより前は元の用途のまま', () => {
    expect(zoneChange('loc-b', ['z-green']).status).toBe('accepted');
    const changedAt = events[0]!.observedAt;
    const cfg = effectiveConfig(base, reduce(events));
    expect(zonesForLocation(cfg, 'loc-b', changedAt)).toEqual(['z-green']);
    expect(zonesForLocation(cfg, 'loc-b', '2026-11-04T08:00:00+09:00')).toEqual([]);
    expect(describeEvent(events[0]!, cfg).text).toBe('用途を変更：緑ゾーン');
  });

  it('用途を外せる。病院設定の対応も、変更の時刻で終わる', () => {
    zoneChange('loc-a', []);
    const cfg = effectiveConfig(base, reduce(events));
    expect(zonesForLocation(cfg, 'loc-a', events[0]!.observedAt)).toEqual([]);
    expect(zonesForLocation(cfg, 'loc-a', '2026-11-04T08:00:00+09:00')).toEqual(['z-red']);
  });

  it('1つの場所に複数の用途を割り当てられる。設定にない用途は受け付けない', () => {
    zoneChange('loc-b', ['z-red', 'z-green']);
    expect(zonesForLocation(effectiveConfig(base, reduce(events)), 'loc-b', events[0]!.observedAt).sort()).toEqual(['z-green', 'z-red']);
    expect(zoneChange('loc-b', ['z-purple']).status).toBe('rejected');
  });
});
