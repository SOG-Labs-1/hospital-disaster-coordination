import { defineConfig, devices } from '@playwright/test';

// 画面の動作確認。テスト専用のポートと保存先（e2e/.tmp）を使い、data/ には書き込まない
const SERVER_PORT = 4100;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1366, height: 900 },
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'rm -rf e2e/.tmp && npx tsx server/src/main.ts',
      env: { SERVER_PORT: String(SERVER_PORT), DATA_DIR: 'e2e/.tmp/data', DEFAULT_HOSPITAL: 'claude' },
      url: `http://localhost:${SERVER_PORT}/api/health`,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -w web',
      env: { WEB_PORT: String(WEB_PORT), API_TARGET: `http://localhost:${SERVER_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
    },
  ],
});
