import { defineConfig, devices } from '@playwright/test';

// 公開デモ（審査用）の URL に向けて、審査員と同じ流れを確かめる。
//   DEMO_URL=https://... npx playwright test -c e2e-demo
// 公開デモに記録が増える（架空のデータ）。しばらく操作がなければ、公開デモは最初の状態に戻る
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.DEMO_URL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1366, height: 900 },
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
