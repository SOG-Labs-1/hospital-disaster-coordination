import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHospitalConfig, type HospitalConfig } from '@hdc/shared';

export const repoRoot = resolve(import.meta.dirname, '../..');
export const hospitalsDir = join(repoRoot, 'config/hospitals');

/** 配信する病院設定の id の一覧。指定がなければ config/hospitals/ にあるすべて */
export function resolveHospitalIds(fromEnv: string | undefined, dir = hospitalsDir): string[] {
  if (fromEnv) return fromEnv.split(',').map((x) => x.trim()).filter(Boolean);
  const ids = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')).sort();
  if (ids.length === 0) throw new Error(`病院設定が見つからない（${dir}）`);
  return ids;
}

/** config/hospitals/<id>.yaml を読み込んで検証する。誤りがあれば起動を止める */
export function loadHospitalConfig(id: string, dir = hospitalsDir): HospitalConfig {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`病院設定の id が不正: ${id}`);
  const path = join(dir, `${id}.yaml`);
  const result = parseHospitalConfig(readFileSync(path, 'utf8'));
  if (!result.ok) throw new Error(`病院設定 ${path} に誤りがあります:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  return result.config;
}
