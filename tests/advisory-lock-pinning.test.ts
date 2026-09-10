import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { lockEndpoints } from "../packages/pipeline-core/src/lib/lock";
import { scoreRelevance } from "../packages/pipeline-core/src/lib/visualRelevance";

/**
 * A session-scoped advisory lock needs one session for both halves.
 *
 * Measured against this project's Neon database on 2026-09-10, one trial per
 * fresh lock id: the pooled endpoint leaked the lock as soon as any other query
 * ran concurrently (lock@668 -> unlock@965, released=false), while the direct
 * endpoint held it under the same load. `connection_limit=1` alone did NOT fix
 * the pooled case. Hence: a dedicated client (so pipeline traffic cannot steal
 * the connection) AND a non-pooler endpoint (so PgBouncer cannot reassign the
 * backend).
 *
 * The endpoint resolution is pure, so the rewrite is provable without a
 * database; the connection behaviour itself is not unit-testable here and was
 * verified by measurement, recorded in lock.ts.
 */

const POOLED = "postgresql://u:p@ep-late-bread-ad0ci3kq-pooler.c-2.us-east-1.aws.neon.tech/db?sslmode=require";
const DIRECT_HOST = "ep-late-bread-ad0ci3kq.c-2.us-east-1.aws.neon.tech";

describe("the lock connection bypasses the pooler", () => {
  test("a Neon pooler URL yields its direct twin first", () => {
    const [first] = lockEndpoints(undefined, POOLED);
    assert.equal(first.source, "direct");
    assert.equal(new URL(first.url).host, DIRECT_HOST, "the -pooler label is dropped");
  });

  test("every candidate is pinned to a single connection", () => {
    for (const e of lockEndpoints(undefined, POOLED)) {
      assert.equal(new URL(e.url).searchParams.get("connection_limit"), "1",
        `${e.source} must not let Prisma spread the two statements across a pool`);
    }
  });

  test("the original URL is kept as a last resort, never dropped", () => {
    // A direct endpoint that is firewalled off must degrade, not take the
    // pipeline down. A leaked lock only ever over-blocks.
    const sources = lockEndpoints(undefined, POOLED).map((e) => e.source);
    assert.deepEqual(sources, ["direct", "as-is"]);
    const last = lockEndpoints(undefined, POOLED).at(-1)!;
    assert.match(new URL(last.url).host, /-pooler\./);
  });

  test("an explicit override wins outright", () => {
    const override = "postgresql://u:p@lock.example.internal/db";
    const eps = lockEndpoints(override, POOLED);
    assert.equal(eps[0].source, "explicit");
    assert.equal(new URL(eps[0].url).host, "lock.example.internal");
  });

  test("a non-pooler URL is used as-is — Railway's own Postgres needs no rewrite", () => {
    const plain = "postgresql://u:p@containers.railway.app:5432/railway";
    const eps = lockEndpoints(undefined, plain);
    assert.deepEqual(eps.map((e) => e.source), ["as-is"],
      "no pooler to bypass, so there is nothing to derive");
    assert.equal(new URL(eps[0].url).host, "containers.railway.app:5432");
    assert.equal(new URL(eps[0].url).searchParams.get("connection_limit"), "1");
  });

  test("no DATABASE_URL yields no candidates rather than a bad guess", () => {
    // Passing `undefined` falls through to the env default, so the env is what
    // has to be absent.
    const saved = { lock: process.env.PIPELINE_LOCK_DATABASE_URL, db: process.env.DATABASE_URL };
    delete process.env.PIPELINE_LOCK_DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.deepEqual(lockEndpoints(), []);
    } finally {
      if (saved.lock !== undefined) process.env.PIPELINE_LOCK_DATABASE_URL = saved.lock;
      if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
    }
  });

  test("an unparseable DSN is passed through untouched, not corrupted", () => {
    const dsn = "host=localhost user=postgres dbname=pipeline";
    assert.equal(lockEndpoints(undefined, dsn)[0].url, dsn);
  });
});

describe("a failed release is loud", () => {
  const SRC = readFileSync("packages/pipeline-core/src/lib/lock.ts", "utf8");

  test("the return value of pg_advisory_unlock is read and reported", () => {
    // It does not throw when the session does not hold the lock — it returns
    // false and says nothing. That silence is what hid this.
    assert.match(SRC, /pg_advisory_unlock\(\$1\) AS released/,
      "the release must ask for its result");
    assert.match(SRC, /if \(!released\)[\s\S]{0,200}console\.error/,
      "a false release must be logged at error level");
  });

  test("the old comment claiming locks self-release is gone", () => {
    assert.doesNotMatch(
      SRC, /advisory locks are session-scoped,\s*\n?\s*\/\/\s*so the lock is automatically released when the connection drops/,
      "that assumption is what made the leak invisible");
    assert.ok(SRC.includes("SESSION-scoped"), "the real constraint is stated instead");
  });

  test("the lock client is disconnected on every path", () => {
    // Acquired-and-failed, acquired-and-succeeded, and never-acquired.
    assert.equal((SRC.match(/opened\.client\.\$disconnect\(\)/g) ?? []).length, 2,
      "the contended path and the finally path each release the connection");
  });

  test("the public signature is unchanged", () => {
    assert.match(SRC, /export async function withAdvisoryLock<T>\(\s*prisma: PrismaClient,\s*lockId: number,\s*fn: \(\) => Promise<T>,/);
  });
});

describe("bare trading is off-domain for Wet Circuit", () => {
  const wc = (description: string) => scoreRelevance({
    channel: "wet-circuit",
    narration: "The GMI 40 shows depth, speed and wind on one screen at the helm.",
    prompt: "marine instrument display on a boat",
    description,
  });

  test("the clip that slipped through the phrase list is refused", () => {
    const r = wc("dynamic trading scene with tech display");
    assert.equal(r.verdict, "REJECT");
    assert.equal(r.concept, "off-domain");
  });

  test("marine footage is unaffected", () => {
    for (const d of [
      "close up shot of gps screen",
      "close up shot of fuel gauge",
      "chartplotter screen showing a nautical chart",
      "sonar fishfinder display on a console",
      "yacht rudder extreme close up",
    ]) {
      assert.notEqual(wc(d).concept, "off-domain", d);
    }
  });

  test("AI Doom still keeps trading footage", () => {
    const r = scoreRelevance({
      channel: "ai-doom-scroll",
      narration: "Trading desks now run models that move faster than any human.",
      prompt: "stock market trading floor",
      description: "dynamic trading scene with tech display",
    });
    assert.notEqual(r.concept, "off-domain");
  });
});
