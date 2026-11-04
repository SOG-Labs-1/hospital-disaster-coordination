import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHospitalConfig, parseHospitalTemplate, parseScenario, type HospitalConfig, type HospitalTemplate, type Scenario } from '@hdc/shared';

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

export const scenariosDir = join(repoRoot, 'scenarios');

/** 病院を作る画面の標準の値 */
export function loadHospitalTemplate(path = join(repoRoot, 'config/templates/hospital-defaults.yaml')): HospitalTemplate {
  const r = parseHospitalTemplate(readFileSync(path, 'utf8'));
  if (!r.ok) throw new Error(`標準の値 ${path} に誤りがあります:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
  return r.template;
}

/** 画面から作った病院設定（data/hospitals/*.yaml）を読み込む。読めないファイルは知らせて飛ばす（ほかの病院は止めない） */
export function loadCreatedHospitals(dir: string): HospitalConfig[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .flatMap((f) => {
      const r = parseHospitalConfig(readFileSync(join(dir, f), 'utf8'));
      if (r.ok) return [r.config];
      console.warn(`⚠ 画面から作った病院設定 ${f} を読めなかった:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
      return [];
    });
}

/** scenarios/*.yaml を読み込んで検証する。配信する病院のシナリオだけを返す。誤りがあれば起動を止める */
export function loadScenarios(hospitals: HospitalConfig[], dir = scenariosDir): Scenario[] {
  if (!existsSync(dir)) return [];
  const out: Scenario[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const first = parseScenario(text);
    if (!first.ok) throw new Error(`シナリオ ${f} に誤りがあります:\n${first.errors.map((e) => `  - ${e}`).join('\n')}`);
    const config = hospitals.find((h) => h.id === first.scenario.hospital);
    if (!config) continue;
    const r = parseScenario(text, config);
    if (!r.ok) throw new Error(`シナリオ ${f} に誤りがあります:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
    out.push(r.scenario);
  }
  return out;
}
