import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app';
import { createAiProvider } from './ai';
import { MockProvider } from './ai/mock';
import { loadCreatedHospitals, loadHospitalConfig, loadHospitalTemplate, loadScenarios, repoRoot, resolveHospitalIds } from './config';

// .env（API キーなど）はサーバーだけが読む。リポジトリにはコミットしない
const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// HOSPITALS: 配信する病院（カンマ区切り。省略時は config/hospitals/ のすべて）
// DEFAULT_HOSPITAL: 病院を指定せずに開いたときの病院（省略時は病院が1つだけならその病院、複数なら選ぶ画面を出す）
// PORT は開発ツールが画面用に設定することがあるので、専用の名前にする
const hospitalIds = resolveHospitalIds(process.env.HOSPITALS);
const defaultHospitalId = process.env.DEFAULT_HOSPITAL || undefined;
const port = Number(process.env.SERVER_PORT ?? 4000);
const dataDir = process.env.DATA_DIR ?? join(repoRoot, 'data');

// リポジトリの病院設定（架空のデモ用）と、画面から作った病院設定（data/hospitals。git の管理外）
const createdDir = join(dataDir, 'hospitals');
const hospitals = [...hospitalIds.map((id) => loadHospitalConfig(id)), ...loadCreatedHospitals(createdDir)];
const scenarios = loadScenarios(hospitals);
// 訓練の部署役（AI_PROVIDER=mock|anthropic）。災害運用の記録には使わない
// 設定の誤りで災害運用まで止めないよう、部署役を作れなければ mock に切り替えて起動する
const provider = await createAiProvider().catch((err) => {
  console.warn(`⚠ 部署役（AI）を準備できなかったため、決まった返事（mock）で動かします：${(err as Error).message}`);
  return new MockProvider();
});
const app = createApp({ hospitals, dataDir, defaultHospitalId, staticDir: join(repoRoot, 'web/dist'),
  training: { scenarios, provider },
  hospitalCreation: { template: loadHospitalTemplate(), dir: createdDir },
  // 映像の録画専用の起動（video/capture/record.ts が DEMO_CAPTURE=1 を渡す）
  demoCapture: process.env.DEMO_CAPTURE === '1',
});

app.server.listen(port, () => {
  console.log(`院内災害対応 調整ツール: http://localhost:${port}`);
  for (const h of hospitals) console.log(`  病院設定: ${h.name}（${h.id}）`);
  console.log(`  記録の保存先: ${dataDir}/<病院id>/（live.sqlite / training/<回>.sqlite / training-sim.sqlite）`);
  console.log(`  訓練シナリオ: ${scenarios.map((s) => s.id).join(', ') || 'なし'}　部署役: ${provider.name}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
