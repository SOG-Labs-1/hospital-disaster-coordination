# 公開デモ（審査用）の入れ物。Cloud Run で動かす。
# 架空のデモ用データだけを使い、記録は入れ物の中（.demo-data/）に置く。入れ物が起動し直すと最初の状態に戻る。
# APIキーは入れ物に入れない（Cloud Run の環境変数に Secret Manager から渡す）。
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=development

# 依存（npm workspaces）
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

# ソースと設定
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
COPY config config
COPY scenarios scenarios
COPY scripts scripts

# 画面をビルドして、サーバーから配信する
RUN npm run build -w web

# 公開デモの設定（Cloud Run 側で上書きできる）
ENV PUBLIC_DEMO=1 \
    DEMO_RESET_IDLE_MINUTES=30 \
    TRAINING_RUNS_PER_DAY=50 \
    HOSPITALS=claude,hackathon \
    PORT=8080
EXPOSE 8080

# 起動して、空ならデモ用データを入れる（scripts/demo/start.ts）
CMD ["npx", "tsx", "scripts/demo/start.ts"]
