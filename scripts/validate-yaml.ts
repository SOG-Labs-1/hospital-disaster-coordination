// config/ と scenarios/ の YAML を検証する。
//   npm run validate:config -- <ファイル...>   指定したファイルを検証（省略時は全件）
//   tsx scripts/validate-yaml.ts --hook        Claude Code の PostToolUse フックから呼ぶ（標準入力でツールの入力を受け取る）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { relative, resolve, join } from 'node:path';
import { validateYamlFile } from './validate-yaml-lib.ts';

const root = resolve(import.meta.dirname, '..');

function allTargets(): string[] {
  const out: string[] = [];
  for (const dir of ['config', 'scenarios']) {
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ya?ml$/.test(e.name)) out.push(p);
      }
    };
    walk(join(root, dir));
  }
  return out;
}

function run(files: string[]): boolean {
  let ok = true;
  for (const file of files) {
    const rel = relative(root, file);
    const result = validateYamlFile(rel, readFileSync(file, 'utf8'));
    if (result.skipped) continue;
    if (result.errors.length === 0) {
      console.log(`OK  ${rel}（${result.kind}）`);
    } else {
      ok = false;
      console.error(`NG  ${rel}（${result.kind}）`);
      for (const e of result.errors) console.error(`    - ${e}`);
    }
  }
  return ok;
}

if (process.argv.includes('--hook')) {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const filePath: string | undefined = input?.tool_input?.file_path;
  if (!filePath) process.exit(0);
  const abs = resolve(root, filePath);
  const rel = relative(root, abs);
  if (!/^(config|scenarios)\//.test(rel) || !/\.ya?ml$/.test(rel) || !existsSync(abs)) process.exit(0);
  // 失敗時は終了コード 2 で標準エラーを Claude に返す
  process.exit(run([abs]) ? 0 : 2);
} else {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const files = args.length ? args.map((a) => resolve(process.cwd(), a)) : allTargets();
  process.exit(run(files) ? 0 : 1);
}
