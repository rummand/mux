# mux as a gateway (Railway): routes, keys, metering and the dashboard; no model processes. Compute is the providers'.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
# A gateway runs no models, so Laya's ONNX runtime is dropped once the build is done.
RUN npm run build && npm prune --omit=dev && rm -rf node_modules/@receptron node_modules/onnxruntime-*
ENV NODE_ENV=production MUX_ROLE=gateway MUX_HOME=/data MUX_HOST=0.0.0.0
WORKDIR /app/server
CMD ["node", "dist/index.js"]
