# Build context: repository root (NOT packages/monitor).
# railway.toml sets dockerfilePath = "packages/monitor/Dockerfile" to pick this up.
FROM node:22-slim

# Install fontconfig + Bebas Neue display font for thumbnail SVG rendering
# (monitor's regenerateThumbnail action also produces thumbnails).
RUN apt-get update \
 && apt-get install -y fontconfig \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/share/fonts/truetype/custom
COPY assets/fonts/BebasNeue-Regular.ttf /usr/share/fonts/truetype/custom/
RUN fc-cache -f -v

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

# ── Generate Prisma client BEFORE TypeScript builds ─────────────────────
# Monitor's schema is a superset of the root schema — it defines the
# pipeline models (Topic/Video/VideoStatus — imported by pipeline-core)
# plus the channel-scoped monitor tables (imported by monitor). A single
# generate against this schema satisfies both packages.
RUN npx prisma generate --schema=packages/monitor/prisma/schema.prisma

# pipeline-core must build first (monitor imports from its dist/).
RUN npm run build --workspace=packages/pipeline-core \
 && npm run build --workspace=packages/monitor

# ── Safety net: make /app/dist resolve to monitor's build output ─────────
# Railway may run `npm start` from /app, which invokes the ROOT
# package.json's start script (`node dist/index.js`) — that path belongs to
# the AI Doom Scroll service and doesn't exist here. Symlink /app/dist to
# monitor's dist so `node dist/index.js` works regardless of which command
# Railway ends up running (Dockerfile CMD, dashboard override, npm start,
# or a cloned config from another service).
RUN ln -s packages/monitor/dist /app/dist

CMD ["node", "packages/monitor/dist/index.js"]
