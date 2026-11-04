import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@hdc/shared';
import { loadHospitalConfig, repoRoot } from './config';

const ids = readdirSync(join(repoRoot, 'config/hospitals'))
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => f.replace(/\.yaml$/, ''));

describe.each(ids)('病院設定 %s', (id) => {
  const config = loadHospitalConfig(id);

  it('架空の病院として読み込める', () => {
    expect(config.fictional).toBe(true);
    expect(config.name).toMatch(/\(仮\)|（仮）/);
  });

  it('トリアージ区分は記号と印刷の枠線が区分ごとに異なる（色だけに頼らない）', () => {
    const symbols = config.triageCategories.map((t) => t.symbol);
    const borders = config.triageCategories.map((t) => t.printBorder);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(new Set(borders).size).toBe(borders.length);
  });

  it('トリアージ区分の文字色と背景色は WCAG 2.2 AA（4.5:1）を満たす', () => {
    for (const t of config.triageCategories) {
      expect(contrastRatio(t.color, t.textColor), t.label).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it('存在しない病院設定や不正な id は読み込まない', () => {
  expect(() => loadHospitalConfig('../etc')).toThrow();
  expect(() => loadHospitalConfig('nothing-here')).toThrow();
});

it('HOSPITAL_CONFIG の指定がなく設定が複数あるときは起動を止める', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolveHospitalId } = await import('./config');
  const dir = mkdtempSync(join(tmpdir(), 'hdc-cfg-'));
  writeFileSync(join(dir, 'a.yaml'), '');
  expect(resolveHospitalId(undefined, dir)).toBe('a');
  expect(resolveHospitalId('b', dir)).toBe('b');
  writeFileSync(join(dir, 'b.yaml'), '');
  expect(() => resolveHospitalId(undefined, dir)).toThrow(/HOSPITAL_CONFIG/);
});
