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

# ── Copy sources explicitly (no whole-directory COPY) ────────────────────
# Enumerate each required path inside packages/* to avoid BuildKit failing
# a whole-directory COPY with a spurious "source not found" error.
COPY packages/pipeline-core/src       ./packages/pipeline-core/src/
COPY packages/pipeline-core/tsconfig.json ./packages/pipeline-core/tsconfig.json

COPY packages/monitor/src             ./packages/monitor/src/
COPY packages/monitor/prisma          ./packages/monitor/prisma/
COPY packages/monitor/tsconfig.json   ./packages/monitor/tsconfig.json

# pipeline-core must build first (monitor imports from its dist/).
RUN npm run build --workspace=packages/pipeline-core \
 && npm run build --workspace=packages/monitor

# Generate Prisma client against monitor's schema (the one with channel columns).
RUN npx prisma generate --schema=packages/monitor/prisma/schema.prisma

CMD ["node", "packages/monitor/dist/index.js"]
