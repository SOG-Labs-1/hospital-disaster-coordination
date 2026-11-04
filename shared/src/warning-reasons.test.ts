import { describe, expect, it } from 'vitest';
import { reasonsForWarnings } from './commands';
import type { HospitalConfig } from './config';

const config = {
  warningReasons: [
    { id: 'same', label: '別の患者であることを確認した', requiresDetail: false, appliesTo: ['DUPLICATE_TAG_NUMBER'] },
    { id: 'urgent', label: '緊急のため', requiresDetail: false, appliesTo: ['TRANSPORTER_BUSY', 'CAPACITY_EXCEEDED'] },
    { id: 'hq', label: '本部の指示による', requiresDetail: false },
  ],
} as unknown as HospitalConfig;
const ids = (codes: string[]) => reasonsForWarnings(config, codes).map((r) => r.id);

describe('警告に合う理由だけを出す', () => {
  it('警告の種類に当てはまる理由と、種類を限らない理由を出す', () => {
    expect(ids(['DUPLICATE_TAG_NUMBER'])).toEqual(['same', 'hq']);
    expect(ids(['TRANSPORTER_BUSY'])).toEqual(['urgent', 'hq']);
  });

  it('警告が2種類出ているときは、両方に当てはまる理由だけを出す', () => {
    expect(ids(['TRANSPORTER_BUSY', 'CAPACITY_EXCEEDED'])).toEqual(['urgent', 'hq']);
    expect(ids(['DUPLICATE_TAG_NUMBER', 'TRANSPORTER_BUSY'])).toEqual(['hq']);
  });

  it('当てはまる理由が1つもなければ、選べなくならないように全部を出す', () => {
    const only = { warningReasons: [config.warningReasons[0]!] } as unknown as HospitalConfig;
    expect(reasonsForWarnings(only, ['TRANSPORTER_BUSY']).map((r) => r.id)).toEqual(['same']);
  });
});
