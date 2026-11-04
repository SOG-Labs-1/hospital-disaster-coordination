import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from './commands';
import { buildHospitalConfig, parseHospitalTemplate, type HospitalDraftInput } from './hospital-builder';
import { reduce } from './state';

const t = parseHospitalTemplate(readFileSync(join(import.meta.dirname, '../../config/templates/hospital-defaults.yaml'), 'utf8'));
if (!t.ok) throw new Error(t.errors.join('\n'));
const template = t.template;

const draft = (over: Partial<HospitalDraftInput> = {}): HospitalDraftInput => ({
  name: 'テスト作成病院(仮)',
  fictional: true,
  locations: [
    { name: '本部', kind: 'headquarters', hasTerminal: true },
    { name: '処置室', kind: 'emergency', hasTerminal: true, capacity: { red: 2 } },
    { name: '待合', kind: 'outpatient', hasTerminal: false, capacity: { yellow: 5, green: 10 } },
  ],
  zoneAssignments: [
    { zoneId: 'red-zone', locationIndex: 1 },
    { zoneId: 'yellow-zone', locationIndex: 2 },
    { zoneId: 'green-zone', locationIndex: 2 },
  ],
  positions: { hqChief: true, hqTransport: false, locationLeads: true },
  staff: [{ name: '架空 太郎', locationIndex: 0, professionId: 'clerk', staffNumber: 'A-1' }],
  transporters: ['搬送1'],
  ...over,
});

describe('画面の入力から病院設定を組み立てる', () => {
  it('標準の値と合わせ、既存の病院と同じスキーマで検証した設定になる', () => {
    const r = buildHospitalConfig(draft(), template, 'h-test');
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const c = r.config;
    expect(c).toMatchObject({ id: 'h-test', name: 'テスト作成病院(仮)', fictional: true, staleAfterMinutes: template.staleAfterMinutes });
    expect(c.locations.map((l) => l.id)).toEqual(['hq', 'loc-2', 'loc-3']);
    expect(c.capacity).toEqual([
      { locationId: 'loc-2', triage: 'red', value: 2 },
      { locationId: 'loc-3', triage: 'yellow', value: 5 },
      { locationId: 'loc-3', triage: 'green', value: 10 },
    ]);
    expect(c.zoneAssignments.filter((z) => z.locationId === 'loc-3').map((z) => z.zoneId)).toEqual(['yellow-zone', 'green-zone']);
    // 搬送調整担当がいないときは、本部長が兼任する
    expect(c.positions.map((p) => p.name)).toEqual(['本部長（搬送調整を兼任）', '処置室責任者', '待合責任者']);
    expect(c.staff).toEqual([{ id: 'st-1', name: '架空 太郎', professionId: 'clerk', locationId: 'hq', staffNumber: 'A-1' }]);
    expect(c.transporters).toEqual([{ id: 'tr-1', name: '搬送1' }]);
    expect(c.triageCategories).toEqual(template.triageCategories);
  });

  it('作った病院でそのまま記録できる', () => {
    const r = buildHospitalConfig(draft(), template, 'h-test');
    if (!r.ok) throw new Error();
    const res = decide(reduce([]), r.config, { command: { type: 'RegisterPatient', payload: { locationId: 'loc-2', triage: 'red' } }, meta: { enteredBy: 'st-1', terminal: 'hq' } }, { mode: 'live', now: new Date().toISOString(), newId: () => 'E1' });
    expect(res.status).toBe('accepted');
  });

  it('本部がない・架空の確認がない・入力者がいない・場所の名前が重なる・搬送を指示できる役職がない、は作れない', () => {
    const errs = (over: Partial<HospitalDraftInput>) => {
      const r = buildHospitalConfig(draft(over), template, 'h-x');
      return r.ok ? [] : r.errors;
    };
    expect(errs({ locations: [{ name: '処置室', kind: 'emergency', hasTerminal: true }], zoneAssignments: [], staff: [{ name: '架空 太郎', locationIndex: 0, professionId: 'clerk' }] }).join()).toContain('本部の場所を1つ入れる');
    expect(errs({ fictional: false as never }).length).toBeGreaterThan(0);
    expect(errs({ staff: [] }).join()).toContain('入力者を1人以上入れる');
    expect(errs({ locations: [{ name: '本部', kind: 'headquarters', hasTerminal: true }, { name: '本部', kind: 'ward', hasTerminal: true }], zoneAssignments: [] }).join()).toContain('重なっている');
    expect(errs({ positions: { hqChief: false, hqTransport: false, locationLeads: true } }).join()).toContain('搬送の指示を出せる役職');
    expect(errs({ zoneAssignments: [{ zoneId: 'red-zone', locationIndex: 9 }] }).join()).toContain('場所が見つからない');
    expect(errs({ zoneAssignments: [{ zoneId: 'purple-zone', locationIndex: 1 }] }).length).toBeGreaterThan(0);
  });
});
