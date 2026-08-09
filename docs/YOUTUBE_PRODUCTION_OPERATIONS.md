# YouTube production operations

Everything needed to operate, pause, inspect and recover the two channels.
Written to be usable by someone who did not build the system.

Channels and their services:

| Channel | Pipeline service | Monitor service | Pilot record | Advisory lock |
|---|---|---|---|---|
| `ai-doom-scroll` | `yt-pipeline` | `monitor-ai-doom` | `ai-doom-private-pilot-1` | 123456 |
| `wet-circuit` | `wc-pipeline` | `monitor-wc` | `wet-circuit-private-canary-1` | 789012 |

Railway project `hearty-nature`, environment `production`, deploy branch `main`.

Run every command below from the repository root.

---

## 0. The one command to run first

```bash
npx tsx scripts/monday-preflight.ts
```

Read-only. Ends in `MONDAY_PREFLIGHT = PASS` or `FAIL` with a remedy line per
blocker. It never changes anything, and must never be modified to change
something in order to reach PASS.

For a raw database picture:

```bash
npx tsx scripts/production-snapshot.ts
npx tsx scripts/production-snapshot.ts --json > /tmp/before.json   # for comparison
```

---

## 1. Global emergency stop

Three independent switches. Setting **any** of them stops new production; set
all three if you want to be certain.

```bash
# 1. Pipelines refuse to do anything but an auth check.
railway variables set PIPELINE_MODE=auth_check --service yt-pipeline --skip-deploys
railway variables set PIPELINE_MODE=auth_check --service wc-pipeline --skip-deploys

# 2. No narration can be purchased.
railway variables set DISABLE_ELEVEN=true --service yt-pipeline --skip-deploys
railway variables set DISABLE_ELEVEN=true --service wc-pipeline --skip-deploys

# 3. Nothing new can be authorized.
railway variables set SCHEDULER_ENABLED=false --service monitor-ai-doom --skip-deploys
railway variables set SCHEDULER_ENABLED=false --service monitor-wc --skip-deploys

# Apply (see the WARNING below about --skip-deploys).
railway redeploy --service yt-pipeline --yes
railway redeploy --service wc-pipeline --yes
railway redeploy --service monitor-ai-doom --yes
railway redeploy --service monitor-wc --yes
```

To also stop uploads by an already-running process, additionally disable
unattended mode:

```bash
railway variables set PRODUCTION_MODE=off --service yt-pipeline --skip-deploys
railway variables set PRODUCTION_MODE=off --service wc-pipeline --skip-deploys
```

> **WARNING — always pass `--skip-deploys`.**
> `railway variables set` *without* it triggers a git redeploy from `main`,
> which will discard any CLI-uploaded code and can roll a service back to an
> older commit. The safe sequence is always: set with `--skip-deploys`, then
> `railway redeploy` explicitly.

**A stop does not cancel an in-flight run.** A pipeline already past its gates
keeps going until it finishes or hits the 30-minute hard timeout. Check with:

```bash
npx tsx scripts/production-snapshot.ts | grep -A3 "active runs"
```

## 2. Stop one channel only

Apply the same variables to that channel's services only. Nothing is shared
between channels at runtime: separate services, separate advisory locks,
separate pilot rows, separate budgets.

---

## 3. The scheduler (automatic authorization)

The scheduler decides a video is *owed*. It runs as a tick inside the **monitor**
services and does nothing except insert a `production_cycle` row. It cannot run
a pipeline, spend credits, render or upload.

### Verify it is disabled

```bash
npx tsx scripts/authorization-scheduler-control.ts --check
```

Look for `SCHEDULER_ENABLED : <unset> → DISABLED (no writes possible)`.

In the deployed services:

```bash
railway logs --service monitor-ai-doom | grep scheduler
railway logs --service monitor-wc | grep scheduler
```

A disabled scheduler logs `SKIPPED_DISABLED` on every tick.

### See what it would do, without doing it

```bash
npx tsx scripts/authorization-scheduler-control.ts --dry-run
```

`--dry-run` never writes, even when the scheduler is enabled.

### Enable / disable

```bash
# Enable (only the exact literal "true" works)
railway variables set SCHEDULER_ENABLED=true --service monitor-ai-doom --skip-deploys
railway redeploy --service monitor-ai-doom --yes

# Disable
railway variables set SCHEDULER_ENABLED=false --service monitor-ai-doom --skip-deploys
railway redeploy --service monitor-ai-doom --yes
```

`TRUE`, `1`, `yes`, `enabled` all mean **disabled**. This is deliberate.

### What it will do when enabled

Every 15 minutes it asks: what is the next publication slot for this channel
(Mon/Wed/Fri 15:00 America/New_York), and is it between 1 and 6 hours away? If
yes and no cycle is already open, it authorizes exactly one. Otherwise it logs
why not. Duplicate ticks are absorbed by the unique `(channel, slot)` index.

**Enabling the scheduler alone does not produce videos.** The pipeline also has
to be in unattended mode (`PRODUCTION_MODE=unattended`) and out of
`auth_check`. Both gates are required.

---

## 4. Inspecting production cycles

```bash
npx tsx scripts/production-cycle-control.ts --check --channel ai-doom-scroll
npx tsx scripts/production-cycle-control.ts --check --channel wet-circuit
```

Shows the runnable cycle, the next slot, anything needing a human, and recent
history.

### Authorize one cycle by hand

```bash
npx tsx scripts/production-cycle-control.ts --authorize --channel ai-doom-scroll \
  --i-understand-this-authorizes-one-unattended-video
```

Refuses while another cycle is open, and refuses any slot that is not a real
Mon/Wed/Fri 15:00 ET publication slot. Running it twice for the same slot is a
no-op, not a second video.

### Verify one cycle

```bash
npx tsx scripts/production-cycle-control.ts --verify --channel ai-doom-scroll --cycle <id>
```

---

## 5. Cycle statuses

| Status | Meaning | Runnable again? |
|---|---|---|
| `AUTHORIZED` | A video is owed. Nothing has claimed it. | Yes |
| `CLAIMED` | A pipeline owns it. May or may not have a candidate yet. | Yes — by the same channel runner, so a crash can resume |
| `COMPLETED` | The video was produced and the cycle closed. | Never |
| `FAILED` | Terminal failure with no external side effect. | Never |
| `RECONCILIATION_REQUIRED` | YouTube may hold something we did not record. | Never — human only |

`currentRunnableCycle` only ever returns `AUTHORIZED` or `CLAIMED`, and only
while `targetPublishSlot` is still in the future. **A cycle whose slot has
passed stops blocking new authorizations automatically** — forward progress
never requires human action.

---

## 6. Stale `CLAIMED` handling

A cycle stuck in `CLAIMED` means a container claimed it and died. It stops
blocking once its slot passes, so this is hygiene, not an outage.

### Step 1 — inspect (read-only, always safe)

```bash
npx tsx scripts/production-cycle-control.ts --inspect-stale \
  --channel ai-doom-scroll --cycle <id>
```

Dispositions:

| Disposition | Meaning | Action |
|---|---|---|
| `NOT_STALE` | Claimed less than 45 minutes ago. | Wait. A run may still be going. |
| `OWNER_ALIVE` | The channel advisory lock is **held**. | **Do nothing.** A pipeline is running. |
| `SAFE_TO_FAIL` | Owner proven gone; nothing reached YouTube. | Step 2. |
| `NEEDS_RECONCILIATION` | Owner gone, but a video may exist remotely. | Step 2, then §8. |
| `NOT_CLAIMED` | Already terminal. | Nothing to do. |

### Step 2 — terminalise (only after inspecting)

```bash
npx tsx scripts/production-cycle-control.ts --reap \
  --channel ai-doom-scroll --cycle <id> \
  --i-understand-this-terminates-an-abandoned-cycle
```

This holds the channel's advisory lock across the update, so a container that
starts mid-recovery cannot have its cycle taken from under it. It moves the
cycle to `FAILED` or `RECONCILIATION_REQUIRED` — **never** back to `AUTHORIZED`,
and it never clears `claimantId` or detaches the candidate.

Why 45 minutes: a pipeline force-exits at 30 minutes
(`PIPELINE_HARD_TIMEOUT_MS`), so a process cannot legitimately be alive past
it. 45 is that ceiling plus slack. The longest successful run ever observed is
13.3 minutes.

### Its candidate

Reaping the cycle does not clean up an attached candidate row. Inspect it and,
if it is genuinely dead, quarantine it rather than deleting it.

---

## 7. `FAILED` handling

Terminal and safe: nothing reached YouTube. No action is required — the next
authorization proceeds normally at the next slot. Read `failureCode` to learn
which stage failed, then fix the cause.

Do **not** re-authorize the same slot to "retry". Authorize the *next* slot, or
use guarded manual production (§11).

---

## 8. `RECONCILIATION_REQUIRED` handling

This means **a video may exist on the channel that we have no record of**. It is
never retried automatically, and must not be retried by hand until resolved.

### Step 1 — find out what YouTube actually has

Each upload writes a correlation id into the video's tags *before* the remote
call, so a remote object is self-identifying even when we lost its id.

```bash
npx tsx scripts/production-cycle-control.ts --verify --channel <ch> --cycle <id>
npx tsx scripts/production-snapshot.ts | grep -A5 "unresolved intents"
```

Then check the channel itself (YouTube Studio → Content, including **private**
and **scheduled**) for a video matching the cycle's candidate, published near
the cycle's `claimedAt`.

### Step 2 — decide, as a human

- **A video exists and is correct** → record its id against the candidate and
  treat the cycle as done. Do not produce another.
- **A video exists and is wrong/partial** → delete it in YouTube Studio first,
  then treat the cycle as `FAILED` and authorize a later slot.
- **No video exists** → the ambiguity is resolved; treat as `FAILED` and
  authorize a later slot.

### Step 3 — never do this

Do not re-run the pipeline for the same cycle "to see what happens". That is
precisely how a duplicate upload happens.

---

## 9. Checking for an orphaned upload without retrying

```bash
npx tsx scripts/production-snapshot.ts | grep -A10 "unresolved intents"
```

Intent states and what they mean:

| State | YouTube saw it? | Safe to retry? |
|---|---|---|
| `PREPARED` | No | Yes |
| `FAILED_BEFORE_REMOTE_CALL` | No | Yes |
| `UPLOAD_STARTED` | **Unknown** | **No** — reconcile first |
| `REMOTE_CONFIRMED` | Yes, id known | No — persist the id |
| `PERSISTED` | Yes | No — done |
| `RECONCILIATION_REQUIRED` | Unknown | No — human only |
| `RECONCILED_HISTORICAL_UPLOAD` | Yes | No — done |

---

## 10. Verifying spend, runs, intents and schedule

```bash
npx tsx scripts/production-snapshot.ts
```

Covers the ElevenLabs ledger and reservations, controlled budget limits, active
runs, unresolved intents, future scheduled videos, pilots and circuit breakers.

A non-zero `reserved` with no active run is a stuck reservation and will block
the next budget window — investigate before running anything.

---

## 11. Manual ordinary production (guarded)

Human-authorized, one video, then exit. Unrelated to the scheduler.

```bash
npx tsx scripts/ordinary-production-control.ts --channel ai-doom-scroll
npx tsx scripts/ordinary-production-control.ts --channel ai-doom-scroll --run \
  --i-understand-this-creates-and-schedules-a-production-video
npx tsx scripts/ordinary-production-control.ts --channel ai-doom-scroll --verify --video <id>
```

## 12. Publication scheduling after human review

```bash
npx tsx scripts/video-publication-control.ts --channel ai-doom-scroll --video <rowId>
npx tsx scripts/video-publication-control.ts --channel ai-doom-scroll --video <rowId> \
  --schedule --i-have-reviewed-and-approved-this-video
npx tsx scripts/video-publication-control.ts --channel ai-doom-scroll --video <rowId> --verify
```

---

## 13. Pilot execution

### AI Doom

```bash
npx tsx scripts/ai-doom-pilot-control.ts                                              # CHECK
npx tsx scripts/ai-doom-pilot-control.ts --arm --i-understand-this-activates-the-pilot
npx tsx scripts/ai-doom-pilot-control.ts --run --i-understand-this-spends-credits
npx tsx scripts/ai-doom-pilot-control.ts --relock                                     # ALWAYS after a run
npx tsx scripts/ai-doom-pilot-control.ts --advance-cap --i-have-reviewed-the-previous-video
```

### Wet Circuit

```bash
DISABLE_ELEVEN=true npx tsx scripts/wc-feasibility-verify.ts   # required, expires after 24h
npx tsx scripts/wc-canary-control.ts                           # CHECK
npx tsx scripts/wc-canary-control.ts --arm --i-understand-this-spends-credits
npx tsx scripts/wc-canary-control.ts --run --i-understand-this-spends-credits
```

Both pilots may only run inside their execution window: **Mon/Wed/Fri
17:00–20:00 America/New_York**, end-exclusive. That window is when the pipeline
may *run*; it is not a publication time.

**Unattended production must stay off during a pilot.** Keep
`PRODUCTION_MODE` unset and `SCHEDULER_ENABLED` disabled, so a pilot and an
unattended cycle can never compete for the same channel.

---

## 14. Auth-check and monitor health-only modes

`PIPELINE_MODE=auth_check` — the pipeline verifies its YouTube credentials and
channel binding, then exits. It reaches no stage, creates no candidate and
spends nothing. This is the resting state.

`MONITOR_MODE` — fail-closed, exact values only:

| Value | Behaviour |
|---|---|
| unset / empty | `DISABLED` — process exits immediately |
| `disabled` | Exits immediately |
| `health_only` | Deterministic health checks + authorization tick only. No YouTube writes, no Claude, no comments. |
| `active` | Full legacy monitoring |
| anything else | **Throws** — never silently degrades |

`MONITOR_AI_ENABLED` only suppresses Claude calls. **It is not a kill switch**
— a monitor with AI off still ran everything else. `MONITOR_MODE` is the kill
switch.

---

## 15. Rollback

### Find the last known-good commit

```bash
git log --oneline -20 origin/main
railway deployment list --service yt-pipeline --json | head -40
```

The running commit is the newest deployment with status `SUCCESS`. A `SKIPPED`
deployment means Watch Paths matched nothing, so the previous build is still
live — `SKIPPED` is normal and not a failure.

### Redeploy a known-good commit

Preferred — move `main` back and let Railway deploy it:

```bash
git checkout main && git pull
git revert --no-edit <bad-sha>      # revert, do not force-push
git push origin main
```

Never `git push --force` to `main`. Railway deploys what `main` points at, and
a force-push makes the deployed history unreconstructable.

If a service needs to be pushed back without a code change:

```bash
railway redeploy --service <svc> --yes
```

### After any rollback

```bash
npx tsx scripts/monday-preflight.ts
```

---

## 16. Safety invariants — do not "fix" these

1. **One authorization is at most one video.** Candidate creation and the
   cycle's record of it are one transaction.
2. **A container start is not an authorization.** Both a durable cycle and
   `PRODUCTION_MODE=unattended` are required.
3. **A stale cycle is never reset to `AUTHORIZED`.** That would re-arm it to
   produce a second candidate.
4. **Liveness comes from the advisory lock, never from the clock.**
5. **Ambiguous uploads are never retried automatically.**
6. **`_prisma_migrations` is frozen at 0011.** Later migrations were applied via
   `npx prisma db execute --file`. Never run `prisma migrate deploy` against the
   root schema — it would drop the seven monitor tables. See `docs/DATABASE.md`.
7. **Always `--skip-deploys` on `railway variables set`.**
