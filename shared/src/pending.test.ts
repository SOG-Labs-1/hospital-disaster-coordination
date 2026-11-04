import { describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput } from './commands';
import type { DomainEvent } from './events';
import { pendingForLocation, reduce, versionOf } from './state';
import { testConfig } from './test-fixtures';

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };

function scenario(commands: ((events: DomainEvent[]) => CommandEnvelopeInput)[]): DomainEvent[] {
  const events: DomainEvent[] = [];
  let seq = 0;
  for (const make of commands) {
    const r = decide(reduce(events), config, make(events), { mode: 'training', now: new Date(Date.parse('2026-11-04T09:00:00+09:00') + seq * 60000).toISOString(), newId: () => `E${String(++seq).padStart(4, '0')}` });
    if (r.status !== 'accepted') throw new Error(JSON.stringify(r));
    events.push(...r.events);
  }
  return events;
}
const tv = (events: DomainEvent[], id: string) => versionOf(reduce(events), { kind: 'transport', id });
const sv = (events: DomainEvent[], id: string) => versionOf(reduce(events), { kind: 'support', id });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('部署ごとの対応待ち', () => {
  it('受け入れ判断・出発・到着の記録が、それぞれの場所の対応待ちに出る', () => {
    const base = [
      () => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', triage: 't2' } }, meta }),
      () => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }),
    ] as ((e: DomainEvent[]) => CommandEnvelopeInput)[];
    let events = scenario(base);
    expect(ids(pendingForLocation(reduce(events), 'loc-b').acceptRequests)).toEqual(['T-001']);
    expect(ids(pendingForLocation(reduce(events), 'loc-a').departures)).toEqual(['T-001']);

    events = scenario([
      ...base,
      (e) => ({ command: { type: 'AcceptTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'lead-b' } } }, meta, expectedVersion: tv(e, 'T-001') }),
      (e) => ({ command: { type: 'RecordDeparture', transportId: 'T-001', payload: {} }, meta, expectedVersion: tv(e, 'T-001') }),
    ]);
    const b = pendingForLocation(reduce(events), 'loc-b');
    expect(b.acceptRequests).toHaveLength(0);
    expect(ids(b.arrivals)).toEqual(['T-001']);
    expect(pendingForLocation(reduce(events), 'loc-a').departures).toHaveLength(0);
  });

  it('断った搬送は対応待ちから外れる', () => {
    const events = scenario([
      () => ({ command: { type: 'RegisterPatient', payload: { locationId: 'loc-a' } }, meta }),
      () => ({ command: { type: 'RequestTransport', payload: { patientId: 'P-001', toLocationId: 'loc-b' } }, meta }),
      (e) => ({ command: { type: 'DeclineTransport', transportId: 'T-001', payload: { decidedBy: { positionId: 'lead-b' }, reason: '満床' } }, meta, expectedVersion: tv(e, 'T-001') }),
    ]);
    const s = reduce(events);
    expect(pendingForLocation(s, 'loc-b').acceptRequests).toHaveLength(0);
    expect(pendingForLocation(s, 'loc-a').departures).toHaveLength(0);
  });

  it('支援は届け先の「届くはず」と、手配先の「送るはず」に出る', () => {
    const events = scenario([
      () => ({ command: { type: 'RequestSupport', payload: { fromLocationId: 'loc-b', kindId: 'k-supply', items: [{ resourceId: 'res1', quantity: 2 }] } }, meta }),
      (e) => ({ command: { type: 'DispatchSupport', supportId: 'S-001', payload: { providerLocationId: 'loc-a' } }, meta, expectedVersion: sv(e, 'S-001') }),
    ]);
    const s = reduce(events);
    expect(ids(pendingForLocation(s, 'loc-b').supportsToReceive)).toEqual(['S-001']);
    expect(ids(pendingForLocation(s, 'loc-a').supportsToProvide)).toEqual(['S-001']);
    const done = scenario([
      () => ({ command: { type: 'RequestSupport', payload: { fromLocationId: 'loc-b', kindId: 'k-supply', items: [{ resourceId: 'res1', quantity: 2 }] } }, meta }),
      (e) => ({ command: { type: 'DispatchSupport', supportId: 'S-001', payload: { providerLocationId: 'loc-a', toLocationId: 'hq' } }, meta, expectedVersion: sv(e, 'S-001') }),
    ]);
    expect(pendingForLocation(reduce(done), 'loc-b').supportsToReceive).toHaveLength(0);
    expect(ids(pendingForLocation(reduce(done), 'hq').supportsToReceive)).toEqual(['S-001']);
  });
});
