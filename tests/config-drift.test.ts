import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  PUBLISH_DAYS, PUBLISH_HOUR_LOCAL, PUBLISH_TIMEZONE, publicationPolicyFor,
  CHANNELS, CHANNEL_LOCK_IDS, channelLockId,
  PIPELINE_HARD_TIMEOUT_MS, CLAIM_STALE_AFTER_MS,
  AUTHORIZATION_LEAD_MS, MINIMUM_LEAD_MS,
  CONFIGURED_RANGE, OBSERVED_RANGE, runtimeRange,
} from "@yt-pipeline/pipeline-core";

/**
 * Constants that exist in more than one place.
 *
 * Some duplication is unavoidable — a Prisma default, a hardcoded lock id in a
 * pipeline, a pinned channel id in an authorization record — and the cost of
 * centralising every one of them exceeds the risk. What is NOT acceptable is
 * duplication that can drift silently, and this project has already been bitten
 * once: scripts/prepare-wc-canary.ts kept `windowDays: [2,4]` after the durable
 * pilot and the canary authorization had both moved to [1,3,5], and because
 * that script repairs drift by writing its own constants back, re-running it
 * would have reverted the pilot and blocked a canary run.
 *
 * So each value below is pinned to its canonical source. Where two values are
 * intentionally different, that is stated rather than left to be rediscovered.
 */

function src(p: string): string {
  return readFileSync(p, "utf8");
}

function tracked(glob: string): string[] {
  return execFileSync("git", ["ls-files", glob], { encoding: "utf8" })
    .split("\n").filter((f) => f && !f.includes("node_modules"));
}

// ── Advisory lock ids ─────────────────────────────────────────────────────

describe("advisory lock ids", () => {
  test("the reaper's ids match the ids the pipelines actually take", () => {
    // This is the highest-consequence duplication in the repository. The stale
    // -cycle reaper proves an owner is gone by ACQUIRING the channel's lock; if
    // it took a different lock than the pipeline holds, that proof would be
    // vacuous and it could terminalise a cycle belonging to a live run.
    assert.match(src("packages/pipeline-core/src/config.ts"),
      new RegExp(`PIPELINE_LOCK_ID: z\\.coerce\\.number\\(\\)\\.default\\(${channelLockId("ai-doom-scroll")}\\)`));
    assert.match(src("packages/wc-pipeline/src/pipeline.ts"),
      new RegExp(`WC_LOCK_ID = ${channelLockId("wet-circuit")}\\b`));
  });

  test("no two channels share a lock id", () => {
    const ids = Object.values(CHANNEL_LOCK_IDS);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ── Channel identity ──────────────────────────────────────────────────────

describe("channel ids", () => {
  test("every hardcoded channel id matches the canonical CHANNELS table", () => {
    const canonical = new Set(Object.values(CHANNELS).map((c) => c.id));
    for (const f of [...tracked("packages/**/*.ts"), ...tracked("src/**/*.ts"),
                     ...tracked("scripts/*.ts")]) {
      for (const m of src(f).matchAll(/"(UC[A-Za-z0-9_-]{20,})"/g)) {
        assert.ok(canonical.has(m[1]),
          `${f} pins channel id ${m[1]} which is not in CHANNELS`);
      }
    }
  });

  test("the WC canary authorization pins the canonical Wet Circuit id", () => {
    assert.match(src("packages/wc-pipeline/src/canary/authorization.ts"),
      new RegExp(CHANNELS["wet-circuit"].id));
  });
});

// ── Publication cadence ───────────────────────────────────────────────────

describe("publication cadence", () => {
  test("both channels resolve to the canonical policy", () => {
    for (const ch of ["ai-doom-scroll", "wet-circuit"]) {
      const p = publicationPolicyFor(ch);
      assert.deepEqual(p.days, PUBLISH_DAYS);
      assert.equal(p.hour, PUBLISH_HOUR_LOCAL);
      assert.equal(p.timeZone, PUBLISH_TIMEZONE);
    }
  });

  test("the publication-control tool's own default matches the canonical policy", () => {
    const s = src("scripts/video-publication-control.ts");
    const days = [...s.matchAll(/days: \[([\d, ]+)\]/g)]
      .map((m) => m[1].split(",").map((n) => Number(n.trim())));
    assert.ok(days.length > 0, "expected the tool to declare its default days");
    for (const d of days) assert.deepEqual(d, PUBLISH_DAYS);
  });

  test("every hardcoded Eastern timezone literal is the canonical one", () => {
    for (const f of [...tracked("packages/**/*.ts"), ...tracked("scripts/*.ts")]) {
      for (const m of src(f).matchAll(/"(America\/[A-Za-z_]+)"/g)) {
        assert.equal(m[1], PUBLISH_TIMEZONE,
          `${f} uses timezone ${m[1]}, not the canonical ${PUBLISH_TIMEZONE}`);
      }
    }
  });
});

// ── Pilot execution windows (a DIFFERENT concept) ─────────────────────────

describe("pilot execution windows", () => {
  test("both pilot preparation sources declare Mon/Wed/Fri", () => {
    // The pilot EXECUTION window is not the publication cadence — it is when a
    // pilot may RUN (17:00-20:00 ET) and never becomes a publish time. It
    // happens to share the same weekdays, and that coincidence is exactly what
    // let [2,4] survive unnoticed in one file.
    for (const f of ["scripts/prepare-wc-canary.ts",
                     "packages/wc-pipeline/src/canary/authorization.ts"]) {
      const s = src(f);
      assert.match(s, /\[\s*1,\s*3,\s*5\s*\]/,
        `${f} no longer declares Mon/Wed/Fri for the pilot window`);
      assert.doesNotMatch(s, /windowDays: \[\s*2,\s*4\s*\]/,
        `${f} has reverted to the stale Tue/Thu window`);
    }
  });

  test("the execution window hours are stated, and are not the publish hour", () => {
    const s = src("scripts/prepare-wc-canary.ts");
    assert.match(s, /windowStartHour: 17/);
    assert.match(s, /windowEndHour: 20/);
    assert.notEqual(17, PUBLISH_HOUR_LOCAL,
      "if these ever coincide, the two concepts must still be kept separate");
  });
});

// ── Time limits ───────────────────────────────────────────────────────────

describe("time limits derive rather than duplicate", () => {
  test("neither entrypoint carries its own timeout literal", () => {
    for (const f of ["src/index.ts", "packages/wc-pipeline/src/index.ts"]) {
      assert.match(src(f), /PIPELINE_TIMEOUT_MS = PIPELINE_HARD_TIMEOUT_MS/);
      assert.doesNotMatch(src(f), /30 \* 60 \* 1000/);
    }
  });

  test("the stale threshold is derived from the hard timeout", () => {
    assert.equal(CLAIM_STALE_AFTER_MS, PIPELINE_HARD_TIMEOUT_MS * 1.5);
  });

  test("the scheduler's minimum lead is derived from the hard timeout", () => {
    assert.equal(MINIMUM_LEAD_MS, PIPELINE_HARD_TIMEOUT_MS * 2);
  });

  test("the lead window is ordered and sane", () => {
    assert.ok(MINIMUM_LEAD_MS < AUTHORIZATION_LEAD_MS);
    assert.ok(AUTHORIZATION_LEAD_MS < 48 * 60 * 60 * 1000,
      "the lead must never span two publication slots");
  });

  test("the only 30-minute literal left is the definition itself", () => {
    const files = [...tracked("packages/**/*.ts"), ...tracked("src/**/*.ts")];
    const offenders = files.filter((f) =>
      f !== "packages/pipeline-core/src/lib/runtimeLimits.ts" &&
      /30 \* 60 \* 1000/.test(src(f)));
    assert.deepEqual(offenders, []);
  });
});

// ── Runtime envelope ──────────────────────────────────────────────────────

describe("runtime envelope", () => {
  test("the WC canary authorization matches the range the runtime resolves", () => {
    // The canary manifest is checked against runtimeRange() at resolve time and
    // refuses on drift, so this pins the same source rather than a constant
    // that merely looks similar.
    const range = runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION");
    const s = src("packages/wc-pipeline/src/canary/authorization.ts");
    assert.match(s, new RegExp(`runtimeMinS: ${range.minS}\\b`));
    assert.match(s, new RegExp(`runtimeMaxS: ${range.maxS}\\b`));
  });

  test("CONFIGURED and OBSERVED ranges differ ON PURPOSE for wet-circuit", () => {
    // CONFIGURED is what the scriptGenerator prompt asks for; OBSERVED is
    // grounded in 9 published Wet Circuit videos. They are not the same number
    // and must not be "reconciled" by editing one to match the other — the
    // resolver decides which applies per stage. Pinning the difference stops a
    // future reader from treating it as drift.
    const conf = CONFIGURED_RANGE["wet-circuit"];
    const obs = OBSERVED_RANGE["wet-circuit"];
    assert.notDeepEqual(conf, obs);
    assert.deepEqual(runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION"),
      runtimeRange("wet-circuit", "LONGFORM", "PRODUCTION"),
      "the resolver must be deterministic");
  });
});

// ── Pilot caps ────────────────────────────────────────────────────────────

describe("pilot caps", () => {
  test("the WC canary is a one-video authorization everywhere it is declared", () => {
    for (const f of ["scripts/prepare-wc-canary.ts",
                     "packages/wc-pipeline/src/canary/authorization.ts"]) {
      assert.match(src(f), /maxSuccesses: 1\b/, `${f} does not cap the canary at one`);
    }
  });
});
