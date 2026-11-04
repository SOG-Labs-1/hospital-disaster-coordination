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

  it('シナリオはスキーマと病院設定への参照を確認する', () => {
    const ok = `id: a\ntitle: 訓練\nhospital: claude\nfictional: true\ndurationMinutes: 5\nroles: [{ locationId: er, name: 救急外来 }]\ntimeline:\n  - { type: patientArrives, at: "00:10", locationId: er, patient: { key: p1, triage: red } }\n`;
    expect(validateYamlFile('scenarios/a.yaml', ok).errors).toEqual([]);
    expect(validateYamlFile('scenarios/a.yaml', 'id: a\n').errors.length).toBeGreaterThan(0);
    expect(validateYamlFile('scenarios/a.yaml', ok.replace('triage: red', 'triage: purple')).errors.join()).toContain('purple');
    expect(validateYamlFile('scenarios/a.yaml', ok.replace('fictional: true', 'fictional: false')).errors.length).toBeGreaterThan(0);
    expect(validateYamlFile('scenarios/a.yaml', ok.replace('"00:10"', '"10"')).errors.join()).toContain('分:秒');
  });
});
