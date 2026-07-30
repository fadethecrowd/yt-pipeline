#!/usr/bin/env node
/**
 * Fails closed on schema-changing Prisma commands aimed at the ROOT schema.
 *
 * prisma/schema.prisma does NOT declare the monitor's tables (VideoSnapshot,
 * Comment, MonitorAction, DigestLog, ChannelGoal, TopicSeed, RedditPost).
 * `prisma migrate dev|deploy|reset` and `prisma db push` diff the schema
 * against the live database and DROP whatever the schema omits — so run from
 * the root schema they delete every monitor table and its data.
 *
 * packages/monitor/prisma/schema.prisma is a SUPERSET declaring the pipeline
 * models AND the monitor models. It is the only safe migration path.
 *
 *   node scripts/prisma-guard.mjs <prisma-args...>
 *
 * See docs/DATABASE.md.
 */
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";

export const SAFE_SCHEMA = "packages/monitor/prisma/schema.prisma";
export const ROOT_SCHEMA = "prisma/schema.prisma";

/** Monitor models the root schema is missing. */
export const MISSING_MODELS = [
  "VideoSnapshot", "Comment", "MonitorAction", "DigestLog",
  "ChannelGoal", "TopicSeed", "RedditPost",
];

/**
 * Commands that diff the datamodel against the database and may drop objects.
 * `migrate status|resolve|diff` only read or record, so they are safe.
 */
const SAFE_MIGRATE_SUBS = new Set(["status", "resolve", "diff"]);
const DESTRUCTIVE_DB_SUBS = new Set(["push", "seed"]);

/** Extract `--schema=X` / `--schema X`, returning null when unspecified. */
export function schemaArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--schema=")) return a.slice("--schema=".length);
    if (a === "--schema") return argv[i + 1] ?? null;
  }
  return null;
}

/**
 * True when the effective schema is the incomplete root one.
 *
 * Compares resolved paths, not substrings: the superset path
 * `packages/monitor/prisma/schema.prisma` *contains* `prisma/schema.prisma`,
 * so substring matching would wrongly block the safe path.
 */
export function usesRootSchema(argv, cwd = process.cwd()) {
  const s = schemaArg(argv);
  if (s === null) return true; // Prisma defaults to prisma/schema.prisma
  const rel = relative(resolve(cwd), resolve(cwd, s)).split("\\").join("/");
  return rel === ROOT_SCHEMA;
}

/**
 * Decide whether a Prisma invocation must be blocked.
 * Returns { blocked, reason, command, sub }.
 */
export function evaluate(argv, cwd = process.cwd()) {
  const [cmd, sub] = argv;
  if (!cmd) return { blocked: false, reason: "no command" };

  let schemaChanging = false;
  if (cmd === "migrate") {
    schemaChanging = !SAFE_MIGRATE_SUBS.has(sub);
  } else if (cmd === "db") {
    // `db execute --file` applies reviewed SQL and does not diff the schema —
    // it is the sanctioned way to apply this repo's additive migrations.
    const isReviewedApply = sub === "execute" && argv.includes("--file");
    schemaChanging = DESTRUCTIVE_DB_SUBS.has(sub) || (sub === "execute" && !isReviewedApply);
  }

  if (!schemaChanging) {
    return { blocked: false, reason: "not schema-changing", command: cmd, sub };
  }
  if (!usesRootSchema(argv, cwd)) {
    return { blocked: false, reason: "uses superset schema", command: cmd, sub };
  }
  return {
    blocked: true,
    reason: "schema-changing command against the incomplete root schema",
    command: cmd,
    sub,
  };
}

/** Never echo connection strings or credentials back to the terminal. */
export function redact(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--url=") || a.startsWith("--shadow-database-url=")) {
      out.push(`${a.split("=")[0]}=<REDACTED>`);
    } else if (a === "--url" || a === "--shadow-database-url") {
      out.push(a, "<REDACTED>");
      i++;
    } else if (/^(postgres(ql)?|mysql|mongodb):\/\//i.test(a)) {
      out.push("<REDACTED>");
    } else {
      out.push(a);
    }
  }
  return out.join(" ");
}

export function blockMessage(argv) {
  const safeEquivalent = [...argv];
  const idx = safeEquivalent.findIndex((a) => a.startsWith("--schema"));
  if (idx >= 0) {
    if (safeEquivalent[idx].startsWith("--schema=")) safeEquivalent[idx] = `--schema=${SAFE_SCHEMA}`;
    else safeEquivalent[idx + 1] = SAFE_SCHEMA;
  } else {
    safeEquivalent.push(`--schema=${SAFE_SCHEMA}`);
  }

  return `
╔════════════════════════════════════════════════════════════════════════════╗
║  BLOCKED: schema-changing Prisma command against the ROOT schema            ║
╚════════════════════════════════════════════════════════════════════════════╝

  Attempted:  prisma ${redact(argv)}
  Schema:     ${schemaArg(argv) ?? `${ROOT_SCHEMA} (implicit default)`}

  ${ROOT_SCHEMA} does not declare these monitor models:
    ${MISSING_MODELS.join(", ")}

  Prisma drops whatever the datamodel omits, so this command would DELETE
  those tables and all of their data.

  Safe equivalent (superset schema declares pipeline AND monitor models):

    npx prisma ${redact(safeEquivalent)}

  To apply an already-reviewed additive migration:

    npx prisma db execute --file prisma/migrations/<name>/migration.sql \\
      --schema ${ROOT_SCHEMA}

  Details: docs/DATABASE.md
`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("prisma-guard: no command given");
    process.exit(2);
  }

  const verdict = evaluate(argv);
  if (verdict.blocked) {
    console.error(blockMessage(argv));
    process.exit(1);
  }

  const res = spawnSync("npx", ["prisma", ...argv], { stdio: "inherit" });
  process.exit(res.status ?? 1);
}

// Only execute when invoked directly, so tests can import the pure helpers.
if (process.argv[1] && process.argv[1].endsWith("prisma-guard.mjs")) main();
