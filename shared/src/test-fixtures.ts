import { HospitalConfigSchema, type HospitalConfig } from './config';

/** テスト用の最小の架空病院設定 */
export function testConfig(overrides: Record<string, unknown> = {}): HospitalConfig {
  return HospitalConfigSchema.parse({
    id: 'test',
    name: 'テスト病院(架空)',
    fictional: true,
    staleAfterMinutes: 30,
    locations: [
      { id: 'hq', name: '本部', kind: 'headquarters', hasTerminal: true },
      { id: 'loc-a', name: '場所A', kind: 'emergency', hasTerminal: true },
      { id: 'loc-b', name: '場所B', kind: 'ward', hasTerminal: false },
    ],
    triageCategories: [
      { id: 't1', label: '区分1', symbol: '■', description: '説明1', color: '#b00020', textColor: '#ffffff', printBorder: 'double' },
      { id: 't2', label: '区分2', symbol: '▲', description: '説明2', color: '#ffd400', textColor: '#000000', printBorder: 'solid' },
    ],
    professions: [{ id: 'nurse', name: '看護師' }],
    positions: [
      { id: 'leader', name: '責任者' },
      { id: 'hq-transport', name: '搬送調整担当', locationId: 'hq', permissions: ['direct-transport'] },
      { id: 'lead-a', name: '場所Aの責任者', locationId: 'loc-a', permissions: ['accept-transport'] },
      { id: 'lead-b', name: '場所Bの責任者', locationId: 'loc-b', permissions: ['accept-transport'] },
    ],
    staff: [
      { id: 's1', name: '試験 一郎', professionId: 'nurse' },
      { id: 's2', name: '試験 二郎', professionId: 'nurse', locationId: 'loc-b' },
    ],
    warningReasons: [{ id: 'other', label: 'その他' }],
    capacity: [{ locationId: 'loc-b', triage: 't1', value: 1 }],
    transporters: [
      { id: 'tr1', name: 'Test One' },
      { id: 'tr2', name: 'Test Two' },
      { id: 'tr3', name: 'Test Three' },
    ],
    transporterTeams: [{ id: 'team1', name: '班1', members: ['tr1', 'tr2'] }],
    transportMethods: [{ id: 'stretcher', name: 'ストレッチャー' }],
    transportPolicy: { optionalSteps: ['acknowledged'], handoverOnArrival: true, acceptanceDecidedBy: 'location-lead' },
    ...overrides,
  });
}
