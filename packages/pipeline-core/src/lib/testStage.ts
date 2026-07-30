import type { TestStage } from "@prisma/client";

/**
 * Which testing stage this process is running as. Drives credit budgeting and
 * QA record classification.
 *
 * Defaults to DIAGNOSTIC rather than PRODUCTION so an unconfigured service can
 * never draw on the production budget by accident — PRODUCTION must be asked
 * for explicitly.
 */
export function currentTestStage(): TestStage {
  const raw = (process.env.TEST_STAGE ?? "").toUpperCase();
  const valid: TestStage[] = [
    "DIAGNOSTIC", "QUALIFICATION", "RETEST", "REPEATABILITY", "PRODUCTION",
  ];
  if ((valid as string[]).includes(raw)) return raw as TestStage;
  return "DIAGNOSTIC";
}

/**
 * Test/qualification renders must never be uploaded as anything but private,
 * regardless of the channel's normal publishing configuration.
 */
export function isTestStage(stage: TestStage = currentTestStage()): boolean {
  return stage !== "PRODUCTION";
}
