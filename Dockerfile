# ── Build Stage ─────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Runtime Stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/runtime ./runtime
COPY --from=builder /app/web ./web
COPY --from=builder /app/server.js .
COPY --from=builder /app/manifest ./manifest
COPY --from=builder /app/resources ./resources
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/package.json .

ENV NODE_ENV=production
ENV MCP_PORT=18764
ENV TTS_PORT=18765
ENV WEB_PORT=3000
ENV TTS_BACKEND=http://localhost:18765
ENV MCP_BACKEND=http://localhost:18764

EXPOSE 18764 18765 3000

CMD ["sh", "-c", "node server.js & node web/server.js"]
