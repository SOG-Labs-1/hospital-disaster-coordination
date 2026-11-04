import { join } from 'node:path';
import { createApp } from './app';
import { loadHospitalConfig, repoRoot, resolveHospitalIds } from './config';

// HOSPITALS: 配信する病院（カンマ区切り。省略時は config/hospitals/ のすべて）
// DEFAULT_HOSPITAL: 病院を指定せずに開いたときの病院（省略時は病院が1つだけならその病院、複数なら選ぶ画面を出す）
// PORT は開発ツールが画面用に設定することがあるので、専用の名前にする
const hospitalIds = resolveHospitalIds(process.env.HOSPITALS);
const defaultHospitalId = process.env.DEFAULT_HOSPITAL || undefined;
const port = Number(process.env.SERVER_PORT ?? 4000);
const dataDir = process.env.DATA_DIR ?? join(repoRoot, 'data');

const hospitals = hospitalIds.map((id) => loadHospitalConfig(id));
const app = createApp({ hospitals, dataDir, defaultHospitalId, staticDir: join(repoRoot, 'web/dist') });

app.server.listen(port, () => {
  console.log(`院内災害対応 調整ツール: http://localhost:${port}`);
  for (const h of hospitals) console.log(`  病院設定: ${h.name}（${h.id}）`);
  console.log(`  記録の保存先: ${dataDir}/<病院id>/（live.sqlite / training.sqlite）`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
