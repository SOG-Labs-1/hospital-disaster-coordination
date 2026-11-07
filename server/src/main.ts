import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
// デモ・録画専用の起動（DEMO_CAPTURE=1）は、通常の保存先 data/ では動かさない（架空のデモ用データが、消せない災害運用の記録に混ざるため）
// 書き方（相対パス・末尾の / ・シンボリックリンク）の違いで抜けないよう、実際の場所で比べる
const realDir = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
if (process.env.DEMO_CAPTURE === '1' && realDir(dataDir) === realDir(join(repoRoot, 'data'))) {
  console.error('DEMO_CAPTURE=1 のときは、DATA_DIR にデモ・録画専用の保存先を指定してください（通常の data/ には書き込みません）');
  process.exit(1);
}

const publicDemo = process.env.PUBLIC_DEMO === '1';
if (publicDemo && process.env.DEMO_CAPTURE !== '1') {
  console.error('PUBLIC_DEMO=1 は、デモ専用の保存先で起動したとき（DEMO_CAPTURE=1）だけ使えます');
  process.exit(1);
}

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
  // HOSPITAL_CREATION=0 で、画面から病院を作る機能を止められる（設定が固まった院内の運用では止めておける）
  hospitalCreation: process.env.HOSPITAL_CREATION === '0' ? undefined : { template: loadHospitalTemplate(), dir: createdDir },
  // ALLOWED_HOSTS: localhost・IP アドレス・*.local 以外の名前で開くときに、カンマ区切りで指定する
  allowedHosts: (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  // PUBLIC_DEMO=1：インターネットに公開する審査用のデモ（架空のデータだけ。下で、しばらく操作がなければ最初に戻す）
  ...(publicDemo ? { publicDemo: { maxCreatedHospitals: 10, writesPerMinute: 120, trainingRunsPerDay: Number(process.env.TRAINING_RUNS_PER_DAY ?? 50) } } : {}),
  // デモ・録画専用の起動（npm run demo が DEMO_CAPTURE=1 を渡す）
  demoCapture: process.env.DEMO_CAPTURE === '1',
});

// 本文を送り終えない遅い接続で、資源を使い切られないように（全端末への配信の長い接続には効かない）
app.server.requestTimeout = 30_000;
app.server.headersTimeout = 20_000;

// 公開デモ：最後の書き込みから一定時間（既定30分）操作がなければ、終了して最初の状態に戻す。
// Cloud Run は終了したサーバーを新しく起動し直し、保存先は空になるので、起動のスクリプトが架空のデモ用データを入れ直す
if (publicDemo) {
  const idleMs = Number(process.env.DEMO_RESET_IDLE_MINUTES ?? 30) * 60_000;
  setInterval(() => {
    const last = app.lastWriteAt();
    if (last !== null && Date.now() - last > idleMs) {
      console.log('公開デモ：しばらく操作がないため、最初の状態に戻します（終了して起動し直す）');
      app.close().then(() => process.exit(0));
    }
  }, 60_000).unref();
}

app.server.listen(port, () => {
  console.log(`病院リンクBCP（院内災害対応の調整ツール）: http://localhost:${port}`);
  for (const h of hospitals) console.log(`  病院設定: ${h.name}（${h.id}）`);
  console.log(`  記録の保存先: ${dataDir}/<病院id>/（live.sqlite / training/<回>.sqlite / training-sim.sqlite）`);
  console.log(`  訓練シナリオ: ${scenarios.map((s) => s.id).join(', ') || 'なし'}　部署役: ${provider.name}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
