import { PrismaClient } from "@prisma/client";

// Singleton Prisma client — reuse across the pipeline
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Cleanly disconnect the Prisma client.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function disconnect(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // Already disconnected or connection was never established
  }
}
