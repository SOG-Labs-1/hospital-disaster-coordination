import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発時は /api をサーバーへ転送する。転送先は環境変数で変えられる（E2Eテスト用）
const apiTarget = process.env.API_TARGET ?? 'http://localhost:4000';
const port = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
});
