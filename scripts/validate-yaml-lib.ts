import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHospitalConfig } from '../shared/src/config.ts';
import { parseScenario } from '../shared/src/scenario.ts';

export type YamlValidation = { skipped: boolean; kind: string; errors: string[] };

/** パス（リポジトリからの相対）で種類を決めて検証する */
export function validateYamlFile(relPath: string, text: string): YamlValidation {
  const path = relPath.replaceAll('\\', '/');
  if (path.startsWith('config/hospitals/')) {
    const r = parseHospitalConfig(text);
    return { skipped: false, kind: '病院設定', errors: r.ok ? [] : r.errors };
  }
  if (path.startsWith('scenarios/')) {
    // シナリオのスキーマに加え、指している病院設定の場所・区分・職種があるかも確かめる
    const first = parseScenario(text);
    if (!first.ok) return { skipped: false, kind: 'シナリオ', errors: first.errors };
    const configPath = resolve(import.meta.dirname, '..', 'config/hospitals', `${first.scenario.hospital}.yaml`);
    if (!existsSync(configPath)) return { skipped: false, kind: 'シナリオ', errors: [`hospital「${first.scenario.hospital}」の病院設定がない`] };
    const config = parseHospitalConfig(readFileSync(configPath, 'utf8'));
    if (!config.ok) return { skipped: false, kind: 'シナリオ', errors: [`病院設定「${first.scenario.hospital}」に誤りがある`] };
    const r = parseScenario(text, config.config);
    return { skipped: false, kind: 'シナリオ', errors: r.ok ? [] : r.errors };
  }
  return { skipped: true, kind: '対象外', errors: [] };
}
