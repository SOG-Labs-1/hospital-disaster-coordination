import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './config';

// CLAUDE.md 最優先の決まり 2・3・8 を、コードの形で確かめる
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
const filesIn = (rel: string) =>
  readdirSync(join(repoRoot, rel), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !d.name.endsWith('.test.ts'))
    .map((d) => join(d.parentPath.replace(repoRoot + '/', ''), d.name));
const imports = (src: string) => [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const sharedNames = (src: string) =>
  [...src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@hdc\/shared['"]/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim().replace(/^type\s+/, '')));

describe('AI の分離', () => {
  it('AI のコードは、記録の保存・コマンドの検証・HTTP・訓練の進行に触れない（提案を返すだけ）', () => {
    for (const f of filesIn('server/src/ai')) {
      const src = read(f);
      expect(imports(src).filter((i) => /store|app|training|commands|node:sqlite/.test(i)), f).toEqual([]);
      expect(sharedNames(src).filter((n) => ['decide', 'reduce', 'EventStore', 'advance', 'resolveProposals'].includes(n)), f).toEqual([]);
    }
  });

  // 進行役は、渡された board.submit（中でコマンドの検証 decide を通る）からだけ、部署の端末の記録として書き込む。
  // 自分で decide や保存を使って、検証を飛ばして書き込むことはしない
  it('訓練の進行役は、コマンドの検証も保存も直接使わない（渡された submit からだけ記録する）', () => {
    for (const f of filesIn('server/src/training')) {
      const src = read(f);
      expect(imports(src).filter((i) => i === '../store' || i === '../app'), f).toEqual([]);
      expect(sharedNames(src).includes('decide'), f).toBe(false);
    }
  });

  it('中核の機能（shared・HTTP の記録の処理・画面）は AI のコードを import しない', () => {
    for (const f of [...filesIn('shared/src'), 'server/src/store.ts', ...filesIn('web/src')]) {
      expect(imports(read(f)).filter((i) => /\/ai(\/|$)|@anthropic-ai/.test(i)), f).toEqual([]);
    }
  });

  it('画面のコードに API キーや Claude API への参照がない', () => {
    for (const f of filesIn('web/src')) expect(read(f), f).not.toMatch(/ANTHROPIC|anthropic\.com|sk-ant-/);
  });
});
