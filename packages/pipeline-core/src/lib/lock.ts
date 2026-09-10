import { PrismaClient } from "@prisma/client";

/**
 * Postgres advisory lock to prevent overlapping pipeline runs.
 *
 * `pg_try_advisory_lock` is SESSION-scoped: the lock belongs to the backend
 * session that took it, and only that session can release it. Both halves must
 * therefore run on one connection, and the old implementation guaranteed
 * neither half of that.
 *
 * Measured against this project's own Neon database on 2026-09-10, one trial
 * per fresh lock id, "load elsewhere" meaning eight concurrent queries through
 * a second client while the lock is held — which is all a pipeline run is:
 *
 *   pooled endpoint, no load                     acquire ok, release ok
 *   direct endpoint, no load                     acquire ok, release ok
 *   pooled endpoint, load elsewhere    lock@668 -> unlock@965, released=FALSE, LEAKED
 *   direct endpoint, load elsewhere              acquire ok, release ok
 *   direct endpoint, default pool, load          acquire ok, release ok
 *
 * Two independent causes, and the fix needs both halves:
 *
 *   1. Prisma keeps its own client-side connection pool, so two
 *      `$queryRawUnsafe` calls on the SHARED client need not use the same
 *      connection. A dedicated client, used for nothing but this lock, removes
 *      the pipeline's own traffic from the equation.
 *   2. A transaction pooler (Neon's `-pooler` host is PgBouncer) reassigns the
 *      backing server session between transactions once anything else is in
 *      flight. No client-side setting fixes that — `connection_limit=1` was
 *      measured and still leaked. The lock connection must bypass the pooler.
 *
 * That is why run cmtvw27ix's successor failed 2 seconds after a clean finish
 * at 19:55:16Z with "Advisory lock 789012 already held": the release had gone
 * to a different backend, returned false, and — because nothing checked the
 * return value and `pg_advisory_unlock` does not throw — said nothing at all.
 *
 * The failure mode is worth stating plainly: a leaked lock makes the pipeline
 * refuse to START. It can never cause two runs to overlap, because
 * `pg_try_advisory_lock` still returns false while the lock is held. Being
 * wrong here costs a skipped cycle, never a double spend, which is what makes
 * the degraded fallbacks below acceptable rather than reckless.
 */

/** Where the lock connection should point, in order of preference. */
export interface LockEndpoint {
  url: string;
  /** How it was chosen, for the log line. */
  source: "explicit" | "direct" | "as-is";
}

/** One connection, so Prisma cannot spread the two statements across a pool. */
function pinToOneConnection(raw: string): string {
  try {
    const u = new URL(raw);
    u.searchParams.set("connection_limit", "1");
    // A pool of one still hands the connection back between statements unless
    // it is kept; this is the documented way to ask Prisma for exactly one.
    u.searchParams.set("pool_timeout", "30");
    return u.toString();
  } catch {
    // Not a parseable URL (some drivers accept key=value DSNs). Leave it alone
    // rather than corrupting a connection string we do not understand.
    return raw;
  }
}

/**
 * Candidate lock endpoints, best first.
 *
 * `PIPELINE_LOCK_DATABASE_URL` is the explicit override and always wins — it
 * exists so an operator can point the lock at a direct endpoint we failed to
 * derive, without a code change.
 *
 * Otherwise a Neon pooler host is rewritten to its direct twin by dropping the
 * `-pooler` label, which is exactly how Neon names the pair. A URL with no
 * `-pooler` in it is used as-is: a plain Postgres (Railway's own, or a local
 * one) has no pooler to bypass and needs only cause (1) fixed.
 *
 * Pure and exported so the rewrite is testable without a database.
 */
export function lockEndpoints(
  explicit = process.env.PIPELINE_LOCK_DATABASE_URL,
  database = process.env.DATABASE_URL,
): LockEndpoint[] {
  const out: LockEndpoint[] = [];
  if (explicit) out.push({ url: pinToOneConnection(explicit), source: "explicit" });
  if (database) {
    if (database.includes("-pooler.")) {
      out.push({ url: pinToOneConnection(database.replace("-pooler.", ".")), source: "direct" });
    }
    // Always keep the original as a last resort. A direct endpoint that is
    // firewalled off — plausible on a host we cannot test from here — must
    // degrade to the old behaviour rather than take the pipeline down, and a
    // leaked lock only ever over-blocks.
    out.push({ url: pinToOneConnection(database), source: "as-is" });
  }
  return out;
}

/** Open the first endpoint that connects. Null when none does. */
async function openLockClient(
  label: string,
): Promise<{ client: PrismaClient; endpoint: LockEndpoint } | null> {
  for (const endpoint of lockEndpoints()) {
    const client = new PrismaClient({ datasources: { db: { url: endpoint.url } } });
    try {
      await client.$connect();
      if (endpoint.source === "as-is" && (process.env.DATABASE_URL ?? "").includes("-pooler.")) {
        console.warn(
          `${label} advisory lock is running through a TRANSACTION POOLER — the lock may ` +
          `leak and block the next run. Set PIPELINE_LOCK_DATABASE_URL to a direct ` +
          `(non -pooler) endpoint to fix this.`,
        );
      }
      return { client, endpoint };
    } catch (err) {
      await client.$disconnect().catch(() => {});
      console.warn(
        `${label} lock endpoint (${endpoint.source}) would not connect: ` +
        `${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
  }
  return null;
}

export async function withAdvisoryLock<T>(
  prisma: PrismaClient,
  lockId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const label = `[lock ${lockId}]`;
  const opened = await openLockClient(label);
  // Last resort: the caller's shared client. This is the pre-2026-09-10
  // behaviour and is known to leak under a pooler, so it is announced.
  const lockClient = opened?.client ?? prisma;
  if (!opened) {
    console.warn(
      `${label} no dedicated lock connection available — falling back to the shared ` +
      `client. Acquire and release may land on different sessions; a leaked lock ` +
      `blocks the NEXT run and is cleared by releasing it manually.`,
    );
  } else {
    console.log(`${label} lock session opened via ${opened.endpoint.source} endpoint`);
  }

  const [{ acquired }] = await lockClient.$queryRawUnsafe<[{ acquired: boolean }]>(
    `SELECT pg_try_advisory_lock($1) AS acquired`,
    lockId,
  );

  if (!acquired) {
    if (opened) await opened.client.$disconnect().catch(() => {});
    throw new Error(
      `Advisory lock ${lockId} already held — another pipeline run is active`,
    );
  }

  try {
    return await fn();
  } finally {
    try {
      // The return value is the whole point: `pg_advisory_unlock` does NOT
      // throw when the calling session does not hold the lock, it quietly
      // returns false and emits a warning nobody sees. That silence is what
      // let this leak for as long as it did.
      const [{ released }] = await lockClient.$queryRawUnsafe<[{ released: boolean }]>(
        `SELECT pg_advisory_unlock($1) AS released`,
        lockId,
      );
      if (!released) {
        console.error(
          `${label} RELEASE FAILED — pg_advisory_unlock returned false. This session ` +
          `does not hold the lock, which means acquire and release ran on different ` +
          `backend sessions. The lock is still held and WILL block the next run until ` +
          `its session ends. Endpoint: ${opened?.endpoint.source ?? "shared client"}.`,
        );
      }
    } catch (err) {
      // A genuinely dead connection. Here the old comment was right — the
      // session ended, so Postgres dropped the lock with it.
      console.warn(
        `${label} release could not be sent (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) ` +
        `— the session has ended, so the lock went with it.`,
      );
    } finally {
      if (opened) await opened.client.$disconnect().catch(() => {});
    }
  }
}
