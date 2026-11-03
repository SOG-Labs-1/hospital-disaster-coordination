import { parse as parseYaml } from 'yaml';
import { parseHospitalConfig } from '../shared/src/config.ts';

export type YamlValidation = { skipped: boolean; kind: string; errors: string[] };

/** パス（リポジトリからの相対）で種類を決めて検証する */
export function validateYamlFile(relPath: string, text: string): YamlValidation {
  const path = relPath.replaceAll('\\', '/');
  if (path.startsWith('config/hospitals/')) {
    const r = parseHospitalConfig(text);
    return { skipped: false, kind: '病院設定', errors: r.ok ? [] : r.errors };
  }
  if (path.startsWith('scenarios/')) {
    // シナリオの本格的なスキーマは訓練モードの実装時に追加する。今は最低限の項目だけ確認する
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (e) {
      return { skipped: false, kind: 'シナリオ', errors: [`YAML として読めない: ${(e as Error).message}`] };
    }
    const errors: string[] = [];
    const obj = raw as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) errors.push('最上位はキーと値の組（マップ）にする');
    else {
      for (const key of ['id', 'title', 'hospital'])
        if (typeof obj[key] !== 'string' || obj[key] === '') errors.push(`${key}: 文字列で必ず書く`);
      if (obj.fictional !== true) errors.push('fictional: true を書く（架空のシナリオであることの明示）');
    }
    return { skipped: false, kind: 'シナリオ', errors };
  }
  return { skipped: true, kind: '対象外', errors: [] };
}
