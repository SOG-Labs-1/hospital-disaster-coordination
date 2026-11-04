import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHospitalConfig, type HospitalConfig } from '@hdc/shared';

export const repoRoot = resolve(import.meta.dirname, '../..');
export const hospitalsDir = join(repoRoot, 'config/hospitals');

/** 使う病院設定の id。指定がなければ、設定が1つだけあるときに限りそれを使う（病院名をコードに書かない） */
export function resolveHospitalId(fromEnv: string | undefined, dir = hospitalsDir): string {
  if (fromEnv) return fromEnv;
  const ids = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''));
  if (ids.length === 1) return ids[0]!;
  throw new Error(`環境変数 HOSPITAL_CONFIG で病院設定を選んでください（候補: ${ids.join(', ') || 'なし'}）`);
}

/** config/hospitals/<id>.yaml を読み込んで検証する。誤りがあれば起動を止める */
export function loadHospitalConfig(id: string, dir = hospitalsDir): HospitalConfig {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`病院設定の id が不正: ${id}`);
  const path = join(dir, `${id}.yaml`);
  const result = parseHospitalConfig(readFileSync(path, 'utf8'));
  if (!result.ok) throw new Error(`病院設定 ${path} に誤りがあります:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  return result.config;
}
