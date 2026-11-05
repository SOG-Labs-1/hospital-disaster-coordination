import { describe, expect, it } from 'vitest';
import { decide, type CommandEnvelopeInput } from './commands';
import type { DomainEvent } from './events';
import { activePatients, reduce } from './state';
import { containsMedicalAdvice } from './simulator';
import { testConfig } from './test-fixtures';

// 監査（2026-11-05）で見つかった穴の回帰テスト：細工した番号の1件で、集計が壊れたり全患者が消えたりしないこと

const config = testConfig();
const meta = { enteredBy: 's1', terminal: 'hq' };

function run(envelopes: CommandEnvelopeInput[]) {
  const events: DomainEvent[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-04T09:00:00+09:00');
  const results = envelopes.map((env) => {
    clock += 60_000;
    const r = decide(reduce(events), config, env, { mode: 'training', now: new Date(clock).toISOString(), newId: () => `E${String(++seq).padStart(4, '0')}` });
    if (r.status === 'accepted') events.push(...r.events);
    return r;
  });
  return { events, results };
}

const register: CommandEnvelopeInput = { command: { type: 'RegisterPatient', payload: { locationId: 'loc-a', triage: 't1' } as never }, meta };
const protoNames = ['__proto__', 'toString', 'constructor', 'hasOwnProperty', 'valueOf'];

describe('細工した番号（プロトタイプの名前）', () => {
  it.each(protoNames)('患者の番号「%s」への区分の変更・メモ・識別情報は断り、集計は壊れない', (id) => {
    const { events, results } = run([
      register,
      { command: { type: 'ChangePatientTriage', patientId: id, payload: { triage: 't1' } } as never, meta, expectedVersion: 0 },
      { command: { type: 'UpdatePatientNote', patientId: id, payload: { freeNote: 'x' } } as never, meta, expectedVersion: 0 },
      { command: { type: 'AddPatientIdentifier', patientId: id, payload: { kind: 'tagNumber', value: '9' } } as never, meta, expectedVersion: 0 },
    ]);
    expect(results.slice(1).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(() => reduce(events)).not.toThrow();
    expect(activePatients(reduce(events))).toHaveLength(1);
  });

  it.each(protoNames)('患者の統合の元「%s」は断り、ほかの患者が消えない', (id) => {
    const { events, results } = run([register, { command: { type: 'MergePatients', patientId: 'P-001', payload: { sourceId: id, reason: '同じ人' } } as never, meta, expectedVersion: 1 }]);
    expect(results[1]!.status).toBe('rejected');
    expect(({} as Record<string, unknown>).mergedInto).toBeUndefined();
    expect(activePatients(reduce(events))).toHaveLength(1);
  });

  it.each(protoNames)('存在しない患者「%s」への搬送・支援要請「%s」への操作は断る', (id) => {
    const { results } = run([
      register,
      { command: { type: 'RequestTransport', payload: { patientId: id, fromLocationId: 'loc-a', toLocationId: 'loc-b' } } as never, meta },
      { command: { type: 'AssignSupport', supportId: id, payload: { assignee: 'x' } } as never, meta, expectedVersion: 0 },
      { command: { type: 'LogMessage', payload: { text: 'メモ', relatedIds: [id] } } as never, meta },
    ]);
    expect(results.slice(1).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('状態の辞書はプロトタイプを持たない（"toString" を「ある」と読み違えない）', () => {
    const s = reduce([]);
    expect(s.patients['toString']).toBeUndefined();
    expect(s.supports['constructor']).toBeUndefined();
  });
});

describe('医療の助言の検出（すり抜けの例）', () => {
  it.each([
    'アドレナリン0.3mgを筋注で',
    '区分は赤のほうが良さそうです',
    '止血帯を巻いて圧迫を続けてください',
    '黄色から赤にすべきです',
    '酸素10Lリザーバーで開始を',
    'Please start IV fluids now',
    '診 断は骨折です',
    '手術適応を判断してください',
    '０．３ｍｇを静注',
  ])('「%s」を医療の助言として止める', (text) => {
    expect(containsMedicalAdvice(text)).toBe(true);
  });

  it.each([
    '救急外来です。赤の患者を1人受け入れます',
    '輸液セットを5つお願いします',
    '生理食塩水500mlを2本送ってください',
    '手術室です。受け入れできません。満床です',
    '到着は10分後の見込みです',
  ])('ふつうの連絡「%s」は止めない', (text) => {
    expect(containsMedicalAdvice(text, config)).toBe(false);
  });
});
