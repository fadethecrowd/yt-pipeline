# Database and migrations

All four Railway services — `yt-pipeline`, `wc-pipeline`, `monitor-ai-doom`,
`monitor-wc` — share **one** Neon Postgres database.

## The two schemas

| File | Declares | Safe for migrations? |
|---|---|---|
| `prisma/schema.prisma` | pipeline models only | **NO** |
| `packages/monitor/prisma/schema.prisma` | pipeline models **+** monitor models | **YES** — this is the superset |

The root schema does not declare the monitor's tables:

```
VideoSnapshot   Comment      MonitorAction   DigestLog
ChannelGoal     TopicSeed    RedditPost
```

Prisma drops whatever the schema does not declare. Running `prisma migrate dev`,
`migrate deploy`, `migrate reset` or `db push` against the **root** schema
therefore issues `DROP TABLE` for all seven monitor tables and destroys their
data. This is not hypothetical — a first-cut generation of migration `0012`
produced exactly those `DROP TABLE` statements and was discarded.

## Correct commands

Generate a migration (always from the superset):

```bash
npx prisma migrate diff \
  --from-schema-datasource packages/monitor/prisma/schema.prisma \
  --to-schema-datamodel   packages/monitor/prisma/schema.prisma \
  --script > prisma/migrations/<NNNN_name>/migration.sql
```

Review it, confirm it contains no destructive statement:

```bash
npm run db:check-migrations
```

Apply the reviewed SQL (this does not diff, so it cannot drop anything):

```bash
npx prisma db execute \
  --file prisma/migrations/<NNNN_name>/migration.sql \
  --schema prisma/schema.prisma
```

Regenerate both clients:

```bash
npx prisma generate
npx prisma generate --schema=packages/monitor/prisma/schema.prisma
```

## The guard

`scripts/prisma-guard.mjs` fronts the `db:*` npm scripts and refuses
schema-changing Prisma commands that would run against the root schema. It
allows `db execute --file`, which applies reviewed SQL without diffing.

```bash
npm run db:push      # blocked with an explanation
npm run db:migrate   # blocked with an explanation
npm run db:validate  # validates the superset schema
```

To bypass deliberately you must invoke `npx prisma` directly — the guard exists
so that never happens by accident.

## Keeping the two schemas in sync

Any model added to one schema must be added to the other, or the next migration
generated from the superset will try to drop it. Both currently declare the
additive reliability/QA/cost tables from `0012` and the quarantine/script-failure
tables from `0013`.

## Applied additive migrations

| Migration | Adds | Destructive statements |
|---|---|---|
| `0012_reliability_qa_cost_models` | `elevenlabs_usage`, `scene_record`, `qa_record`, `credit_budget`, `circuit_breaker`, `circuit_breaker_event`, enum `TestStage` | 0 |
| `0013_quarantine_and_script_failures` | `job_quarantine`, `script_generation_failure`, enum `ScriptFailureType` | 0 |

Neither migration modifies, renames, truncates or drops any pre-existing table,
column, index or type.
