import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assertRunnable, PilotBlockedError, zonedParts } from "@yt-pipeline/pipeline-core";
import type { PilotConfig } from "@yt-pipeline/pipeline-core";
import { evaluateAiDoomPilotWindow, assertAiDoomPilotWindow } from "../src/pilotBinding";

/**
 * Fail-closed pilot controls for AI Doom.
 *
 * Three defects, all of the same shape — a control that described itself but
 * did not enforce itself:
 *
 *   1. The pilot gate hung off PILOT_ID. Unset, `currentPilot()` returned null,
 *      `runPipeline` read that as "ordinary production", and a PREPARED pilot
 *      protected nothing.
 *   2. The execution window logged when violated and continued.
 *   3. maxSuccesses=3 meant an accidental restart after video #1 could produce
 *      video #2 before a human saw the first.
 */

const read = (p: string) => readFileSync(p, "utf8");
const PIPELINE = read("src/pipeline.ts");
const BINDING = read("src/pilotBinding.ts");
const WC_PIPELINE = read("packages/wc-pipeline/src/pipeline.ts");

const PILOT: PilotConfig = {
  id: "row-1", pilotId: "ai-doom-private-pilot-1",
  channel: "ai-doom-scroll", channelId: "UCSbJfiA1aobp6G_rgwbHPMw",
  status: "ACTIVE", maxSuccesses: 1, successCount: 0, successVideoIds: [],
  activatedAt: new Date("2026-08-10T21:00:00Z"), completedAt: null,
  privacyStatus: "private", allowPublishAt: false, shortsEnabled: false,
  requireFeasibility: true, requireGuardedUpload: true,
  windowDays: [1, 3, 5], windowStartHour: 17, windowEndHour: 20,
  timezone: "America/New_York",
};

const at = (iso: string) => new Date(iso);
const allow = (iso: string, over: Partial<PilotConfig> = {}) =>
  evaluateAiDoomPilotWindow(at(iso), { ...PILOT, ...over }).allowed;

const codeOf = (fn: () => unknown): string => {
  try { fn(); return "NO_THROW"; }
  catch (e) { return e instanceof PilotBlockedError ? e.code : `OTHER:${(e as Error).message}`; }
};

// ── 1-4, 19. Binding ─────────────────────────────────────────────────────

describe("pilot binding fails closed on every ambiguity", () => {
  test("1/2. a governing pilot with PILOT_ID unset refuses", () => {
    // The critical defect: absence of configuration was read as permission.
    assert.match(BINDING, /PILOT_BINDING_REQUIRED/);
    assert.match(BINDING, /if \(!named\) \{/);
    // Both PREPARED and ACTIVE count as governing, so neither state leaks
    // through as ordinary production.
    assert.match(BINDING, /const GOVERNING = \["PREPARED", "ACTIVE"\] as const/);
  });

  test("3. PILOT_ID naming a different pilot refuses", () => {
    assert.match(BINDING, /PILOT_BINDING_MISMATCH/);
    assert.match(BINDING, /named !== governingPilot\.pilotId/);
  });

  test("4. PILOT_ID resolving to another channel refuses", () => {
    assert.match(BINDING, /PILOT_BINDING_WRONG_CHANNEL/);
    assert.match(BINDING, /bound\.channel !== CHANNEL/);
  });

  test("a stale PILOT_ID with no governing pilot refuses", () => {
    assert.match(BINDING, /PILOT_BINDING_STALE/);
  });

  test("multiple governing pilots refuse rather than picking one", () => {
    assert.match(BINDING, /PILOT_BINDING_AMBIGUOUS/);
    assert.match(BINDING, /governing\.length > 1/);
  });

  test("a missing row for a named pilot refuses", () => {
    assert.match(BINDING, /PILOT_BINDING_MISSING/);
  });

  test("19. ordinary production stays available when no pilot governs", () => {
    // Returning null here is the ONLY non-throwing path, and it requires the
    // database and the environment to agree there is no pilot.
    assert.match(BINDING, /if \(governing\.length === 0\) \{/);
    assert.match(BINDING, /return null; \/\/ Ordinary production/);
  });

  test("every refusal is a throw, never a log", () => {
    for (const code of [
      "PILOT_BINDING_STALE", "PILOT_BINDING_AMBIGUOUS", "PILOT_BINDING_REQUIRED",
      "PILOT_BINDING_MISMATCH", "PILOT_BINDING_MISSING", "PILOT_BINDING_WRONG_CHANNEL",
    ]) {
      const i = BINDING.indexOf(`"${code}"`);
      assert.ok(i > 0, `${code} not found`);
      assert.ok(BINDING.slice(Math.max(0, i - 200), i).includes("throw new PilotBlockedError"),
        `${code} must be thrown`);
    }
  });

  test("the runner uses the binding, not the bare env lookup", () => {
    assert.match(PIPELINE, /const pilot = await resolveAiDoomPilot\(\)/);
    assert.ok(!PIPELINE.includes("await currentPilot()"),
      "currentPilot() alone returns null when PILOT_ID is unset");
  });
});

// ── 5. PREPARED refuses ──────────────────────────────────────────────────

describe("a bound PREPARED pilot still cannot run", () => {
  test("5. assertRunnable refuses PREPARED", () => {
    assert.equal(codeOf(() => assertRunnable({ ...PILOT, status: "PREPARED", activatedAt: null })),
      "PILOT_NOT_ACTIVE");
  });

  test("ACTIVE without an activation timestamp refuses", () => {
    assert.equal(codeOf(() => assertRunnable({ ...PILOT, activatedAt: null })),
      "PILOT_NOT_ACTIVATED");
  });

  test("binding resolves the pilot; runnability is decided separately", () => {
    // Binding answers "which pilot", assertRunnable answers "may it run".
    assert.match(PIPELINE, /assertRunnable\(pilot\)/);
  });
});

// ── 6-15. Hard window ────────────────────────────────────────────────────

describe("the execution window is a hard gate", () => {
  test("6. Monday 18:00 ET is eligible", () => {
    assert.equal(allow("2026-08-10T22:00:00Z"), true);
  });
  test("7. Wednesday 18:00 ET is eligible", () => {
    assert.equal(allow("2026-08-12T22:00:00Z"), true);
  });
  test("8. Friday 18:00 ET is eligible", () => {
    assert.equal(allow("2026-08-14T22:00:00Z"), true);
  });
  test("9. Tuesday is refused", () => {
    assert.equal(allow("2026-08-11T22:00:00Z"), false);
  });
  test("10. Thursday is refused", () => {
    assert.equal(allow("2026-08-13T22:00:00Z"), false);
  });
  test("Saturday and Sunday are refused", () => {
    assert.equal(allow("2026-08-15T22:00:00Z"), false);
    assert.equal(allow("2026-08-16T22:00:00Z"), false);
  });

  test("11. Monday 16:59:59 ET is refused", () => {
    const d = at("2026-08-10T20:59:59Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 16);
    assert.equal(allow("2026-08-10T20:59:59Z"), false);
  });
  test("12. Monday 17:00:00 ET is eligible", () => {
    const d = at("2026-08-10T21:00:00Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 17);
    assert.equal(allow("2026-08-10T21:00:00Z"), true);
  });
  test("13. Monday 19:59:59 ET is eligible", () => {
    const d = at("2026-08-10T23:59:59Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 19);
    assert.equal(allow("2026-08-10T23:59:59Z"), true);
  });
  test("14. Monday 20:00:00 ET is refused (end exclusive)", () => {
    const d = at("2026-08-11T00:00:00Z");
    assert.equal(zonedParts(d, "America/New_York").hour, 20);
    assert.equal(allow("2026-08-11T00:00:00Z"), false);
  });

  test("15. DST — EST and EDT both anchor to 17:00 local", () => {
    // 2026-01-05 Monday, EST (UTC-5): 17:00 local == 22:00 UTC.
    assert.equal(zonedParts(at("2026-01-05T22:00:00Z"), "America/New_York").hour, 17);
    assert.equal(allow("2026-01-05T22:00:00Z"), true);
    // The same UTC hour that is 17:00 in EDT is 16:00 in EST — must refuse.
    assert.equal(zonedParts(at("2026-01-05T21:00:00Z"), "America/New_York").hour, 16);
    assert.equal(allow("2026-01-05T21:00:00Z"), false);
    // Either side of both 2026 transitions still reads 17:00 local.
    for (const iso of ["2026-03-06T22:00:00Z", "2026-03-09T21:00:00Z",
                       "2026-10-30T21:00:00Z", "2026-11-02T22:00:00Z"]) {
      assert.equal(zonedParts(at(iso), "America/New_York").hour, 17, iso);
      assert.equal(allow(iso), true, iso);
    }
  });

  test("the host timezone cannot change the decision", () => {
    const before = process.env.TZ;
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Europe/London"]) {
      process.env.TZ = tz;
      assert.equal(allow("2026-08-10T22:00:00Z"), true, tz);
      assert.equal(allow("2026-08-11T22:00:00Z"), false, tz);
    }
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  });

  test("the assert form throws PILOT_OUTSIDE_WINDOW", () => {
    assert.equal(codeOf(() => assertAiDoomPilotWindow(at("2026-08-11T22:00:00Z"), PILOT)),
      "PILOT_OUTSIDE_WINDOW");
    assert.doesNotThrow(() => assertAiDoomPilotWindow(at("2026-08-10T22:00:00Z"), PILOT));
  });

  test("the window comes from the durable row, not a constant", () => {
    assert.match(BINDING, /days: pilot\.windowDays/);
    assert.match(BINDING, /timeZone: pilot\.timezone/);
    assert.ok(!BINDING.includes("[1, 3, 5]"), "days must not be restated in code");
  });

  test("16. the refusal precedes resume and discovery", () => {
    const gate = PIPELINE.indexOf("assertAiDoomPilotWindow(new Date(), pilot)");
    const resume = PIPELINE.indexOf("const stuckVideo = await prisma.video.findFirst");
    const discovery = PIPELINE.indexOf("topicDiscovery({} as PipelineContext)");
    assert.ok(gate > 0 && resume > gate, "window gate must precede resume");
    assert.ok(discovery > gate, "window gate must precede discovery");
  });

  test("16b. it is no longer advisory", () => {
    assert.ok(!PIPELINE.includes("outside the pilot execution window"),
      "the log-and-continue branch must be gone");
  });

  test("the window applies to pilot runs only, not ordinary production", () => {
    // Completing or removing the pilot must restore unrestricted scheduling.
    // Anchor on the call site, not the import.
    const gateIdx = PIPELINE.indexOf("assertAiDoomPilotWindow(new Date(), pilot)");
    const blockStart = PIPELINE.indexOf("const pilot = await resolveAiDoomPilot();");
    const guard = PIPELINE.indexOf("if (pilot) {", blockStart);
    assert.ok(blockStart > 0 && guard > blockStart && gateIdx > guard,
      "gate must sit inside `if (pilot)`");
  });
});

// ── 17-18. Progressive human-review cap ──────────────────────────────────

describe("the cap enforces human review between videos", () => {
  const remaining = (p: PilotConfig) => Math.max(0, p.maxSuccesses - p.successCount);

  test("17. 1 used of 1 leaves no slot — the next start is refused", () => {
    const used = { ...PILOT, successCount: 1, maxSuccesses: 1 };
    assert.equal(remaining(used), 0);
    assert.equal(codeOf(() => assertRunnable(used)), "PILOT_CAP_REACHED");
  });

  test("18. raising the cap to 2 grants exactly one more slot", () => {
    const raised = { ...PILOT, successCount: 1, maxSuccesses: 2 };
    assert.equal(remaining(raised), 1);
    assert.doesNotThrow(() => assertRunnable(raised));
  });

  test("the progression 0/1 → 1/2 → 2/3 grants one slot at a time", () => {
    for (const [count, max] of [[0, 1], [1, 2], [2, 3]] as const) {
      assert.equal(remaining({ ...PILOT, successCount: count, maxSuccesses: max }), 1);
    }
    // And each stage stops again once used.
    for (const [count, max] of [[1, 1], [2, 2], [3, 3]] as const) {
      assert.equal(remaining({ ...PILOT, successCount: count, maxSuccesses: max }), 0);
    }
  });

  test("the cap is checked before any candidate is created", () => {
    const cap = PIPELINE.indexOf("PILOT_CAP_REACHED");
    const discovery = PIPELINE.indexOf("topicDiscovery({} as PipelineContext)");
    assert.ok(cap > 0 && discovery > cap);
  });

  test("the runner reads remainingSlots from the durable row each run", () => {
    // A redeploy or crash must not reset what the pilot has already used.
    assert.match(PIPELINE, /const left = await remainingSlots\(pilot\.pilotId\)/);
  });
});

// ── 20. WC isolation ─────────────────────────────────────────────────────

describe("20. Wet Circuit is untouched", () => {
  test("WC does not import AI Doom's binding", () => {
    assert.ok(!WC_PIPELINE.includes("pilotBinding"));
    assert.ok(!WC_PIPELINE.includes("resolveAiDoomPilot"));
  });

  test("the binding module is AI Doom scoped", () => {
    assert.match(BINDING, /const CHANNEL = "ai-doom-scroll" as const/);
    assert.ok(!BINDING.includes("wet-circuit"));
    assert.ok(!BINDING.includes("wc-pipeline"));
  });

  test("WC keeps its own canary window guard", () => {
    assert.match(WC_PIPELINE, /assertWcCanaryWindow/);
    assert.match(WC_PIPELINE, /findWcCanaryAuthorization/);
  });

  test("WC still uses currentPilot for its own gate", () => {
    assert.match(WC_PIPELINE, /await currentPilot\(\)/);
  });
});
