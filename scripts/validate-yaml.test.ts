import { describe, expect, it } from 'vitest';
import { validateYamlFile } from './validate-yaml-lib.ts';

describe('validateYamlFile', () => {
  it('config/ と scenarios/ 以外は対象外', () => {
    expect(validateYamlFile('web/foo.yaml', 'a: 1').skipped).toBe(true);
  });

  it('病院設定の誤りを報告する', () => {
    const r = validateYamlFile('config/hospitals/x.yaml', 'id: x\nname: テスト\n');
    expect(r.kind).toBe('病院設定');
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('壊れた YAML を報告する', () => {
    const r = validateYamlFile('scenarios/a.yaml', 'id: [');
    expect(r.errors[0]).toMatch(/YAML として読めない/);
  });

  it('シナリオは最低限の項目を確認する', () => {
    expect(validateYamlFile('scenarios/a.yaml', 'id: a\ntitle: 訓練\nhospital: claude\nfictional: true\n').errors).toEqual([]);
    expect(validateYamlFile('scenarios/a.yaml', 'id: a\n').errors.length).toBeGreaterThan(0);
  });
});
