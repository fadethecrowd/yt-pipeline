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

# ── Copy sources and build ────────────────────────────────────────────────
# Whole-directory COPY mirrors packages/wc-pipeline/Dockerfile exactly.
# Do NOT pre-copy any subdirectory of packages/monitor here — doing so
# confuses BuildKit's directory bookkeeping for the final whole-dir COPY.
COPY packages/pipeline-core ./packages/pipeline-core/
COPY packages/monitor ./packages/monitor/

# pipeline-core must build first (monitor imports from its dist/).
RUN npm run build --workspace=packages/pipeline-core \
 && npm run build --workspace=packages/monitor

# Generate Prisma client against monitor's schema (the one with channel columns).
RUN npx prisma generate --schema=packages/monitor/prisma/schema.prisma

CMD ["node", "packages/monitor/dist/index.js"]
