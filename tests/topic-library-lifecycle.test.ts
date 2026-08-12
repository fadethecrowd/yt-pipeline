import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Topic-library lifecycle invariants.
 *
 * The library had no test coverage at all, while being the one module that
 * permanently mutates durable topic inventory on every live run.
 *
 * The property that actually matters is loop safety. A topic is removed from
 * the eligible pool at SELECTION time, before any later stage can refuse it.
 * That looks wasteful — a topic rejected by visualFeasibilityGate before a
 * single credit is spent is consumed exactly like one that produced a video —
 * but the alternative is worse. Leaving it PENDING means the next run selects
 * the same highest-priority row, generates a fresh script, and fails the same
 * way, forever: the ordinary runner spins on one topic and never reaches the
 * rest of the library. Every run also costs Claude credits to re-script it.
 *
 * So these tests pin "removed from the pool on a live attempt" as deliberate,
 * and they exist to make a future well-meaning "don't waste the topic" change
 * fail loudly rather than quietly reintroduce that spin.
 */

const LIB = readFileSync("packages/pipeline-core/src/lib/topicLibrary.ts", "utf8");
const AI_DOOM_DISCOVERY = readFileSync("src/stages/topicDiscovery.ts", "utf8");
const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");

describe("the eligible pool is exactly the PENDING rows", () => {
  test("selection reads only PENDING, ordered by priority", () => {
    assert.match(LIB, /where:\s*\{\s*channel,\s*status:\s*"PENDING"\s*\}/,
      "the candidate query must be restricted to PENDING rows");
    assert.match(LIB, /orderBy:\s*\[\{\s*priority:\s*"desc"\s*\}/,
      "highest priority first — this is what makes a left-PENDING failure spin");
  });

  test("the status enum is exactly the three modelled states", () => {
    const m = SCHEMA.match(/enum TopicLibraryStatus \{([^}]*)\}/);
    assert.ok(m, "TopicLibraryStatus must exist");
    const values = m![1].split("\n").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(values, ["PENDING", "USED", "ARCHIVED"],
      "adding a state (e.g. FEASIBILITY_FAILED) is a deliberate schema decision " +
      "that must update this test and the lifecycle tests below");
  });
});

describe("a live attempt consumes the topic", () => {
  test("the non-reserve path marks the selected row USED", () => {
    assert.match(LIB, /data:\s*\{\s*status:\s*"USED"\s*\}/,
      "a live selection must leave the pool");
  });

  test("reserve mode leaves it PENDING for dry-run reuse", () => {
    assert.match(LIB, /if \(!reserve\)/,
      "consumption must be conditional on reserve");
    assert.match(LIB, /reserveTopic=true — leaving/,
      "reserve mode must be explicit about not consuming");
  });

  test("AI Doom reserves only in DRY_RUN, so every LIVE run consumes", () => {
    assert.match(AI_DOOM_DISCOVERY,
      /const isDryRun = process\.env\.DISABLE_ELEVEN === "true";/,
      "reserve is driven by DISABLE_ELEVEN, not by run outcome");
    assert.match(AI_DOOM_DISCOVERY,
      /fetchLibraryTopic\("ai-doom", isDryRun\)/,
      "the AI Doom call site passes the dry-run flag as `reserve`");
  });
});

describe("no code path re-eligibilises a topic — this is the loop guard", () => {
  test("nothing writes status back to PENDING", () => {
    assert.doesNotMatch(LIB, /data:\s*\{[^}]*status:\s*"PENDING"/,
      "returning a topic to PENDING lets the ordinary runner spin on it: it is " +
      "the highest-priority row, so the very next run re-selects it, re-scripts " +
      "it, and fails the same way. If topic inventory needs reclaiming, it must " +
      "be a deliberate human/operator action, never an automatic pipeline one.");
  });

  test("the only PENDING literal is the read filter, not a write", () => {
    const pendingWrites = LIB.match(/status:\s*"PENDING"/g) ?? [];
    assert.equal(pendingWrites.length, 1,
      "exactly one PENDING literal should exist — the selection filter");
  });

  test("a disallowed topic is archived regardless of reserve", () => {
    assert.match(LIB, /data:\s*\{\s*status:\s*"ARCHIVED"\s*\}/,
      "content-filter rejections are permanent");
    const archiveIdx = LIB.indexOf('status: "ARCHIVED"');
    const reserveIdx = LIB.indexOf("if (!reserve)");
    assert.ok(archiveIdx < reserveIdx,
      "archiving happens during selection, before the reserve branch, so a " +
      "dry run cannot keep re-selecting a disallowed topic");
  });
});

describe("USED does not mean a video was produced", () => {
  test("the contract is documented, so inventory accounting is not misread", () => {
    assert.match(LIB, /USED means .*attempt/i,
      "the module must say plainly that USED records a consumed live attempt, " +
      "not a produced video — the two were conflated when a pre-spend refusal " +
      "path (visualFeasibilityGate) was added long after this lifecycle was set");
  });
});
