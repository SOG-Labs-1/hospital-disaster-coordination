import { join } from 'node:path';
import { createApp } from './app';
import { loadHospitalConfig, repoRoot } from './config';

const hospitalId = process.env.HOSPITAL_CONFIG ?? 'sakura';
const port = Number(process.env.PORT ?? 4000);
const dataDir = process.env.DATA_DIR ?? join(repoRoot, 'data', hospitalId);

const config = loadHospitalConfig(hospitalId);
const app = createApp({ config, dataDir, staticDir: join(repoRoot, 'web/dist') });

app.server.listen(port, () => {
  console.log(`院内災害対応 調整ツール: http://localhost:${port}`);
  console.log(`  病院設定: ${config.name}（${hospitalId}）`);
  console.log(`  記録の保存先: ${dataDir}（live.sqlite / training.sqlite）`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
