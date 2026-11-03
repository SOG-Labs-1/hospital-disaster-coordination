import { HospitalConfigSchema, type HospitalConfig } from './config';

/** テスト用の最小の架空病院設定 */
export function testConfig(): HospitalConfig {
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
    positions: [{ id: 'leader', name: '責任者' }],
    staff: [{ id: 's1', name: '試験 一郎', professionId: 'nurse' }],
    warningReasons: [{ id: 'other', label: 'その他' }],
  });
}
