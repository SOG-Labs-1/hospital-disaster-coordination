import { describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput } from './commands';
import { describeEvent, eventTypeLabels } from './describe';
import { eventTypes, type DomainEvent } from './events';
import { reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };

function run(makers: ((events: DomainEvent[]) => CommandEnvelopeInput)[]): DomainEvent[] {
  const events: DomainEvent[] = [];
  let seq = 0;
  for (const make of makers) {
    const r = decide(reduce(events), config, make(events), { mode: 'training', now: new Date(Date.parse('2026-11-04T09:00:00+09:00') + seq * 60000).toISOString(), newId: () => `E${++seq}` });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    events.push(...r.events);
  }
  return events;
}
const tv = (e: DomainEvent[]) => versionOf(reduce(e), { kind: 'transport', id: 'T-001' });

describe('記録の説明（クロノロジー）', () => {
  const events = run([
    () => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', triage: 't1', tagNumber: '12', sex: 'female', features: '青い上着' } }, meta }),
    (e) => ({ command: { type: 'ChangePatientTriage', patientId: 'P-001', payload: { triage: 't2' } }, meta, expectedVersion: versionOf(reduce(e), { kind: 'patient', id: 'P-001' }) }),
    () => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }),
    (e) => ({ command: { type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'lead-b', asDeputy: true } } }, meta, expectedVersion: tv(e) }),
    (e) => ({ command: { type: 'AssignTransportStaff', transportId: 'T-001', payload: { transporterIds: ['tr1', 'tr2'], teamId: 'team1' } }, meta, expectedVersion: tv(e) }),
    (e) => ({ command: { type: 'RecordArrival', transportId: 'T-001', payload: {} }, meta, expectedVersion: tv(e) }),
    () => ({ command: { type: 'ReportLocationStatus', locationId: 'loc-b', payload: { accepting: false, capacity: [{ triage: 't1', value: null }] } }, meta }),
    () => ({ command: { type: 'RequestSupport', payload: { fromLocationId: 'loc-b', kindId: 'k-supply', items: [{ resourceId: 'res1', quantity: 3 }] } }, meta }),
    () => ({ command: { type: 'LogMessage', payload: { channel: 'radio', fromLocationId: 'loc-b', text: '受け入れ準備できた', relatedIds: ['T-001'] } }, meta }),
    (e) => ({ command: { type: 'CorrectEvent', eventId: e[1]!.id, payload: { reason: '聞き間違い', retract: true } }, meta, expectedVersion: versionOf(reduce(e), { kind: 'patient', id: 'P-001' }) }),
  ]);
  const byId = new Map(events.map((e) => [e.id, e]));
  const texts = events.map((e) => describeEvent(e, config, (id) => byId.get(id)));

  it('病院設定の名前を使って日本語の1行にする', () => {
    expect(texts[0]).toMatchObject({ category: 'patient', subjectLabel: 'P-001' });
    expect(texts[0]!.text).toBe('患者を登録：■区分1　場所A　タッグ12　特徴：女性、青い上着');
    expect(texts[1]!.text).toBe('区分を▲区分2に変更');
    expect(texts[2]!.text).toBe('搬送の要請：P-001　場所A → 場所B');
    expect(texts[3]!.text).toBe('受け入れ了承（判断：場所Bの責任者・代行）');
    expect(texts[4]!.text).toBe('搬送要員を割り当て：班1（Test One、Test Two）');
    expect(texts[5]!.text).toBe('到着（引き渡し）');
  });

  it('調整と事実を区別する', () => {
    expect(texts[3]!.kind).toBe('coordination');
    expect(texts[5]!.kind).toBe('fact');
  });

  it('未確認は「未確認」、場所の報告は場所名で示す', () => {
    expect(texts[6]).toMatchObject({ category: 'location', subjectLabel: '場所B', text: '状況の報告：受け入れ不可、■区分1の受け入れ可能 未確認' });
  });

  it('支援要請・連絡メモ・訂正', () => {
    expect(texts[7]!.text).toBe('支援の要請（物品）：場所B　物品1 3個');
    expect(texts[8]).toMatchObject({ category: 'message', subjectLabel: 'M-001', text: '無線（場所Bから）：受け入れ準備できた　［T-001］' });
    expect(texts[9]).toMatchObject({ category: 'correction', text: 'P-001 の「区分の変更」を取り消し：聞き間違い' });
  });

  it('すべてのイベントの種類に名前がある', () => {
    for (const t of eventTypes) expect(eventTypeLabels[t]).toBeTruthy();
  });

  it('関係する記録が存在しない連絡メモは受け付けない', () => {
    expect(() => run([() => ({ command: { type: 'LogMessage', payload: { channel: 'phone', text: 'x', relatedIds: ['P-999'] } }, meta })])).toThrow();
  });
});
