# Build context: repository root (NOT packages/monitor).
# railway.toml sets dockerfilePath = "packages/monitor/Dockerfile" to pick this up.
FROM node:22-slim
WORKDIR /app

# ── Install workspace deps ───────────────────────────────────────────────
# Copy manifests only, then npm ci, so this layer caches across source changes.
COPY package*.json ./
COPY packages/pipeline-core/package.json ./packages/pipeline-core/
COPY packages/monitor/package.json ./packages/monitor/

RUN npm ci \
    --workspace=packages/pipeline-core \
    --workspace=packages/monitor \
    --include-workspace-root

# ── Copy entire repo context (robust pattern) ────────────────────────────
# Nested COPYs like `COPY packages/monitor/src ./packages/monitor/src/` were
# failing on Railway BuildKit with a spurious "source not found" error even
# though the paths are tracked in git. `COPY . .` is a single blanket
# operation that matches what the repo-root Dockerfile (yt-pipeline / AI
# Doom Scroll service) has been using successfully on Railway for months.
# .dockerignore keeps node_modules, dist, secrets, and scripts out.
COPY . .

# pipeline-core must build first (monitor imports from its dist/).
RUN npm run build --workspace=packages/pipeline-core \
 && npm run build --workspace=packages/monitor

# Generate Prisma client against monitor's schema (the one with channel columns).
RUN npx prisma generate --schema=packages/monitor/prisma/schema.prisma

CMD ["node", "packages/monitor/dist/index.js"]
