// 審査・デモ用：架空のデモ用データが入った状態で、本番と同じ形（画面をビルドしてサーバーから配信）で起動する。
//
//   npm run demo                 # http://localhost:4600 で起動
//   DEMO_PORT=4700 npm run demo  # ポートを変える
//   AI_PROVIDER=anthropic npm run demo  # 訓練の部署役を Claude API にする（.env の ANTHROPIC_API_KEY が必要）
//
// - 記録はデモ専用の保存先（.demo-data/、git の管理外）に入れる。通常の data/ には書き込まない
// - デモ用データ（scripts/demo/seed.ts）は、保存先が空のときだけ入れる。2回目以降は前回の続きから開く
// - 訓練の部署役は、指定がなければ mock（API を使わない決まった返事）

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');
// Cloud Run などでは、待ち受けるポートが PORT で渡される
const port = process.env.DEMO_PORT ?? process.env.PORT ?? '4600';
const api = `http://localhost:${port}`;
const dataDir = join(root, '.demo-data');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = spawn('npx', ['tsx', 'server/src/main.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, SERVER_PORT: port, DATA_DIR: dataDir, DEMO_CAPTURE: '1', AI_PROVIDER: process.env.AI_PROVIDER ?? 'mock' },
});
const stop = () => server.kill('SIGTERM');
// サーバーが終わったら、このスクリプトも終わる（公開デモで最初の状態に戻すとき、入れ物ごと起動し直すため）
server.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function main() {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${api}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(500);
  }
  const state = (await (await fetch(`${api}/api/h/claude/live/state`)).json()).state;
  if (state.registeredCount === 0) {
    await new Promise<void>((resolve, reject) => {
      const s = spawn('npx', ['tsx', 'scripts/demo/seed.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, DEMO_API: api } });
      s.on('close', (code) => (code === 0 ? resolve() : reject(new Error('デモ用データを入れられなかった'))));
    });
  } else {
    console.log('前回のデモの記録があるので、その続きから開きます（最初からにするときは .demo-data/ フォルダを消してください）');
  }
  console.log(`
デモの準備ができました（データはすべて架空です）
  本部の端末       ${api}/?hospital=claude&terminal=hq&mode=live
  救急外来の端末   ${api}/?hospital=claude&terminal=er&mode=live
  手術室の端末     ${api}/?hospital=claude&terminal=or&mode=live
  掲示用画面       ${api}/?hospital=claude&view=board&mode=live
  訓練モード       ${api}/?hospital=claude&terminal=hq&mode=training
止めるときは Ctrl+C を押します。`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  stop();
  process.exitCode = 1;
});
