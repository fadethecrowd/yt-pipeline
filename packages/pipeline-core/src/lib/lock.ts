import { PrismaClient } from "@prisma/client";

/**
 * Postgres advisory lock to prevent overlapping pipeline runs.
 */
export async function withAdvisoryLock<T>(
  prisma: PrismaClient,
  lockId: number,
  fn: () => Promise<T>,
): Promise<T> {
  // Try to acquire the lock (non-blocking)
  const [{ acquired }] = await prisma.$queryRawUnsafe<[{ acquired: boolean }]>(
    `SELECT pg_try_advisory_lock($1) AS acquired`,
    lockId,
  );

  if (!acquired) {
    throw new Error(
      `Advisory lock ${lockId} already held — another pipeline run is active`,
    );
  }

  try {
    return await fn();
  } finally {
    try {
      await prisma.$queryRawUnsafe(
        `SELECT pg_advisory_unlock($1)`,
        lockId,
      );
    } catch {
      // Connection already closed — advisory locks are session-scoped,
      // so the lock is automatically released when the connection drops.
    }
  }
}
