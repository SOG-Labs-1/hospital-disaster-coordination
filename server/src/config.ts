import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHospitalConfig, type HospitalConfig } from '@hdc/shared';

export const repoRoot = resolve(import.meta.dirname, '../..');

/** config/hospitals/<id>.yaml を読み込んで検証する。誤りがあれば起動を止める */
export function loadHospitalConfig(id: string, dir = join(repoRoot, 'config/hospitals')): HospitalConfig {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`病院設定の id が不正: ${id}`);
  const path = join(dir, `${id}.yaml`);
  const result = parseHospitalConfig(readFileSync(path, 'utf8'));
  if (!result.ok) throw new Error(`病院設定 ${path} に誤りがあります:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  return result.config;
}
