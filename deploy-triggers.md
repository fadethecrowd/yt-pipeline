# Railway Deploy Triggers

This repo hosts four Railway services in a single project (`hearty-nature / production`). Before Watch Paths were rolled out, any push to `main` rebuilt all four services — including unrelated changes like a README edit. Each service now has an explicit Watch Paths config so only relevant code changes trigger rebuilds.

## Services

| Service | Dockerfile | Role |
|---|---|---|
| `yt-pipeline` | `./Dockerfile` (root) | AI Doom publishing pipeline (scheduled run) |
| `wc-pipeline` | `packages/wc-pipeline/Dockerfile` | Wet Circuit publishing pipeline (scheduled run) |
| `monitor-ai-doom` | `packages/monitor/Dockerfile` | Long-running monitor for AI Doom channel |
| `monitor-wc` | `packages/monitor/Dockerfile` | Long-running monitor for Wet Circuit channel |

`monitor-ai-doom` and `monitor-wc` share the same Dockerfile and source; they differ only in the `CHANNEL` env var.

## Watch Paths per service

Configured via Railway dashboard → *Service → Settings → Source → Watch Paths*. Each list is the full set of glob patterns that trigger a rebuild; anything outside every pattern gets ignored.

### `monitor-ai-doom` and `monitor-wc`

```
packages/monitor/**
packages/pipeline-core/**
assets/fonts/**
package*.json
```

The monitor package maintains its own `packages/monitor/prisma/schema.prisma` (covered by `packages/monitor/**`), so root `prisma/**` is intentionally omitted — monitors do not use the root schema.

### `wc-pipeline`

```
packages/wc-pipeline/**
packages/pipeline-core/**
prisma/**
assets/fonts/**
package*.json
```

### `yt-pipeline`

```
src/**
packages/pipeline-core/**
prisma/**
assets/fonts/**
package*.json
tsconfig.json
Dockerfile
nixpacks.toml
```

`yt-pipeline` uses the root `Dockerfile`, root `tsconfig.json`, and root `nixpacks.toml` directly, so each is listed explicitly. The two pipeline services share the root `prisma/schema.prisma`, so both include `prisma/**`.

## Trigger matrix

| Change touches | monitor-ai-doom | monitor-wc | wc-pipeline | yt-pipeline |
|---|---|---|---|---|
| `packages/monitor/**` | rebuild | rebuild | — | — |
| `packages/wc-pipeline/**` | — | — | rebuild | — |
| `packages/pipeline-core/**` | rebuild | rebuild | rebuild | rebuild |
| `src/**` | — | — | — | rebuild |
| `prisma/**` (root) | — | — | rebuild | rebuild |
| `assets/fonts/**` | rebuild | rebuild | rebuild | rebuild |
| root `package*.json` | rebuild | rebuild | rebuild | rebuild |
| root `Dockerfile` / `nixpacks.toml` | — | — | — | rebuild |
| `README.md`, `CLAUDE.md`, root docs | — | — | — | — |

Shared runtime inputs (`packages/pipeline-core/**`, `assets/fonts/**`, root `package*.json`) legitimately trigger every service because every service depends on them.

## Verification summary

Rollout was validated with four canary pushes. Each canary touched a single file in one location and we recorded which service deployment IDs changed.

| Canary | File touched | Services rebuilt | Result |
|---|---|---|---|
| #2 | `packages/wc-pipeline/src/_deploy_canary.txt` | `wc-pipeline`, `yt-pipeline` (still unfiltered at that time) | monitors correctly skipped |
| #3 | `packages/monitor/src/_deploy_canary.txt` | `monitor-ai-doom`, `monitor-wc`, `yt-pipeline` (still unfiltered) | `wc-pipeline` correctly skipped |
| #4 | `README.md` | none | every service correctly skipped |

**Final result:** root-level non-matching file changes — READMEs, CLAUDE.md, this very file — no longer trigger any service rebuild. The rebuild surface now scales with what the change actually affects, not with repo activity.

## Changing a Watch Path

Configure per-service in the Railway dashboard:

1. Open the service → *Settings → Source → Watch Paths*.
2. Edit the pattern list.
3. Click *Apply* (or the dashboard's confirm-changes button).
4. Railway triggers one redeploy of the changed service to pick up the new config.

The patterns in this doc are the source of truth. Keep it updated when the config changes so the repo documents the current Railway behavior.
