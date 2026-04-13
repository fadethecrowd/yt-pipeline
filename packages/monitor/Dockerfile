# Build context: repository root (NOT packages/monitor).
# In Railway: Root Directory = repo root, Dockerfile Path = packages/monitor/Dockerfile.
FROM node:22-slim
WORKDIR /app

# ── Install workspace deps ───────────────────────────────────────────────
# Copy manifests first so Docker can cache the install layer.
COPY package*.json ./
COPY packages/pipeline-core/package.json ./packages/pipeline-core/
COPY packages/monitor/package.json ./packages/monitor/

# Monitor has its own Prisma schema at packages/monitor/prisma.
COPY packages/monitor/prisma ./packages/monitor/prisma/

RUN npm ci \
    --workspace=packages/pipeline-core \
    --workspace=packages/monitor \
    --include-workspace-root

# ── Copy sources and build ────────────────────────────────────────────────
COPY packages/pipeline-core ./packages/pipeline-core/
COPY packages/monitor ./packages/monitor/

# pipeline-core must build first (monitor imports from its dist/).
RUN npm run build --workspace=packages/pipeline-core \
 && npm run build --workspace=packages/monitor

# Generate Prisma client against monitor's schema (the one with channel columns).
RUN npx prisma generate --schema=packages/monitor/prisma/schema.prisma

CMD ["node", "packages/monitor/dist/index.js"]
