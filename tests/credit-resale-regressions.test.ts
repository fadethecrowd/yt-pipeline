import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  validateScriptStructure, checkTitleFidelity, selectFaithfulTitle,
  buildSpokenUnits, spokenCharacterCount, normalize,
} from "@yt-pipeline/pipeline-core";

/**
 * Run e704334a — "The AI Credit Resale Economy", uploaded as 8ogxCTpYwD4.
 *
 * It rendered, passed mechanical QA, and failed human editorial review for two
 * deterministic reasons. Both are driven here by the real persisted artifacts
 * in tests/fixtures/regressions/2026-08-16-credit-resale/, committed in a4569ac
 * before any production code changed.
 */

const DIR = "tests/fixtures/regressions/2026-08-16-credit-resale";
const load = (f: string) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
const FIXTURE = load("script.final.json");
const SEO = load("seo.json");

/** A fresh copy — validation repairs in place. */
const script = () => JSON.parse(JSON.stringify({
  hook: FIXTURE.hook, cta: FIXTURE.cta,
  estimatedTotalDuration: FIXTURE.estimatedTotalDuration,
  segments: FIXTURE.segments,
}));

const occurrences = (haystack: string, needle: string) => {
  const h = normalize(haystack), n = normalize(needle);
  let count = 0, i = 0;
  while ((i = h.indexOf(n, i)) !== -1) { count++; i += n.length; }
  return count;
};

// ── A-D, F: spoken-unit duplication ──────────────────────────────────────

describe("A-F. structural duplication cannot reach the narration", () => {
  test("the fixture reproduces the defect BEFORE the fix", () => {
    const s = script();
    const units = buildSpokenUnits(s);
    // Segment 0 is a truncated PREFIX of the hook, so the unit builder re-adds
    // the whole hook in front of it and the opening is read twice.
    assert.ok(s.segments[0].narration.length < s.hook.length);
    assert.ok(normalize(s.hook).startsWith(normalize(s.segments[0].narration).slice(0, 200)));
    assert.ok(units[0].text.length > s.hook.length && units[0].text.length > s.segments[0].narration.length,
      "unit 0 is hook + segment 0 concatenated — the duplication that shipped");
    assert.ok(units[0].text.startsWith(s.hook), "the hook is read, then read again");
    const firstSentence = s.hook.split(/(?<=[.!?])\s+/)[0]!;
    assert.equal(occurrences(units[0].text, firstSentence), 2,
      "the opening sentence appears twice in what ElevenLabs receives");
  });

  test("A. exact hook duplication cannot reach spoken units twice", () => {
    const s = script();
    // Isolate the hook defect: the fixture also duplicates the CTA line, which
    // is exercised separately in C2.
    s.segments[s.segments.length - 1].narration = "A clean closing segment with distinct prose.";
    // Segment 0 contains the hook verbatim: the unit builder will NOT re-add it.
    s.segments[0].narration = `${s.hook} Body of the first segment continues here.`;
    const r = validateScriptStructure(s);
    assert.equal(r.ok, true, r.rejections.join("; "));
    const units = buildSpokenUnits(s);
    const firstSentence = s.hook.split(/(?<=[.!?])\s+/)[0]!;
    assert.equal(occurrences(units.map((u: any) => u.text).join(" "), firstSentence), 1);
  });

  test("B. the real script is repaired where it can be, and blocked pre-spend regardless", () => {
    const s = script();
    const r = validateScriptStructure(s);
    // The leading hook prefix is unambiguous, so it is removed deterministically.
    assert.ok(r.issues.some((i: any) => i.code === "HOOK_DUPLICATED" && i.repaired),
      `expected a repaired hook duplication, got ${JSON.stringify(r.issues)}`);
    const firstSentence = FIXTURE.hook.split(/(?<=[.!?])\s+/)[0]!;
    assert.equal(occurrences(s.segments[0].narration, firstSentence), 0,
      "the re-read opening is gone from segment 0");
    // It ALSO carries the CTA line duplicated into segment 5, which cannot be
    // repaired deterministically — so the candidate is refused before spend.
    assert.equal(r.ok, false);
    assert.match(r.rejections.join(" "), /spoken 2 times/);
  });

  test("B2. an unrepairable partial overlap is rejected pre-spend, not guessed at", () => {
    const s = script();
    // Interleaved, so no leading whole sentence of the hook can be removed.
    s.segments[0].narration =
      "Something else entirely first. " + FIXTURE.hook.slice(0, 100) + " and then more.";
    const r = validateScriptStructure(s);
    if (!r.ok) {
      assert.match(r.rejections.join(" "), /cannot be repaired deterministically|spoken \d+ times/);
    } else {
      assert.ok(r.issues.some((i: any) => i.repaired), "if it passed, it must have been repaired");
    }
  });

  test("C. CTA duplication cannot be spoken twice", () => {
    const s = script();
    // Isolate the CTA defect from the fixture's hook defect.
    s.segments[0].narration = "A clean opening segment with entirely distinct prose here.";
    const last = s.segments[s.segments.length - 1];
    last.narration = `Closing thoughts on the topic. ${s.cta}`;
    const r = validateScriptStructure(s);
    assert.equal(r.ok, true, r.rejections.join("; "));
    const units = buildSpokenUnits(s);
    const ctaSentence = s.cta.split(/(?<=[.!?])\s+/).slice(-1)[0]!;
    assert.equal(occurrences(units.map((u: any) => u.text).join(" "), ctaSentence), 1);
  });

  test("C2. the fixture's real repeated CTA line is caught", () => {
    const s = script();
    const last = s.segments[s.segments.length - 1];
    // The quality gate observed "I read every comment" duplicated into segment 5.
    last.narration = `${last.narration} I read every comment and the best ones make it into future scripts.`;
    const r = validateScriptStructure(s);
    const units = buildSpokenUnits(s);
    const joined = units.map((u: any) => u.text).join(" ");
    assert.ok(r.ok === false || occurrences(joined, "I read every comment") === 1,
      "a line repeated across units is either rejected or removed");
  });

  test("D. a clean script passes unchanged", () => {
    const clean = {
      hook: "Here is the opening line that sets up the whole story for you.",
      cta: "Subscribe for more breakdowns like this every week.",
      estimatedTotalDuration: 420,
      segments: Array.from({ length: 6 }, (_, i) => ({
        segmentIndex: i, title: `Segment ${i}`,
        narration: `Body sentence one for segment ${i}. Body sentence two for segment ${i}. ` +
          `A third distinct sentence for segment ${i}.`,
        visual_prompt: "p", duration_seconds: 60,
      })),
    };
    const before = JSON.stringify(clean);
    const r = validateScriptStructure(clean);
    assert.equal(r.ok, true, r.rejections.join("; "));
    assert.deepEqual(r.issues, []);
    assert.equal(JSON.stringify(clean), before, "a clean script must not be modified");
  });

  test("F. a structural duplicate is blocked regardless of the quality score", () => {
    // The validator takes only the script — there is no score to be traded off.
    assert.equal(validateScriptStructure.length, 1);
    const src = readFileSync("packages/pipeline-core/src/lib/scriptStructure.ts", "utf8");
    // Code only — the doc comment legitimately explains the 76/75 score history.
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    for (const scoreish of ["qualityScore", "threshold", "score >=", "score <"]) {
      assert.ok(!code.includes(scoreish), `structure must not consult ${scoreish}`);
    }
    // And the stage rejects on structure independently of the quality gate,
    // which runs later.
    const stage = readFileSync("src/stages/scriptGenerator.ts", "utf8");
    assert.match(stage, /script structure rejected before spend/);
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    assert.ok(pipeline.indexOf('name: "scriptGenerator"') < pipeline.indexOf('name: "qualityGate"'));
  });

  test("E. the spoken-unit length contract still holds after repair", () => {
    const s = script();
    validateScriptStructure(s);
    const total = spokenCharacterCount(buildSpokenUnits(s));
    // Repair only ever REMOVES text, so the generator max cannot be breached.
    assert.ok(total <= 5925, `${total} exceeds the generator max`);
    assert.ok(total > 0);
  });
});

// ── G-L: SEO factual fidelity ────────────────────────────────────────────

describe("G-L. a title may not assert what the script never established", () => {
  const EVIDENCE = `${SEO.topicTitle}\n${FIXTURE.segments.map((s: any) => s.narration).join(" ")}`;

  test("the shipped title is exactly what this must block", () => {
    const r = checkTitleFidelity(SEO.selectedTitle, EVIDENCE);
    assert.equal(r.ok, false);
    for (const term of ["stolen", "black market", "proof"]) {
      assert.ok(r.unsupported.includes(term), `${term} should be unsupported: ${JSON.stringify(r)}`);
    }
  });

  test("G. resale -> stolen is blocked absent evidence", () => {
    assert.equal(checkTitleFidelity("Stolen AI Credits Are Being Resold", EVIDENCE).ok, false);
  });

  test("H. secondary market -> black market is blocked absent evidence", () => {
    assert.equal(checkTitleFidelity("The AI Credit Black Market Explained", EVIDENCE).ok, false);
  });

  test("I. explainer -> here's the proof is blocked absent proof", () => {
    assert.equal(checkTitleFidelity("AI Credit Resale — Here's the Proof", EVIDENCE).ok, false);
  });

  test("J. a first-person claim is blocked absent first-person evidence", () => {
    const r = checkTitleFidelity("I Bought AI Credits From a Broker — Here's What Happened", EVIDENCE);
    assert.equal(r.ok, false);
    assert.ok(r.unsupported.includes("first-person claim"));
  });

  test("an unsupported dollar figure is blocked", () => {
    assert.equal(checkTitleFidelity("The $4 Billion AI Credit Market", EVIDENCE).ok, false);
  });

  test("K. a supported high-curiosity rewrite still passes", () => {
    for (const title of [
      "AI Credits Are Being Resold for Profit — Here's How",
      "The Middlemen Quietly Reselling AI Capacity",
      "Token Brokers Are Reshaping How Businesses Buy AI",
    ]) {
      const r = checkTitleFidelity(title, EVIDENCE);
      assert.equal(r.ok, true, `${title}: ${r.reason}`);
    }
  });

  test("a supported escalation passes when the script earns it", () => {
    const r = checkTitleFidelity("The Stolen Credits Nobody Talks About",
      "investigators traced stolen API keys resold through brokers");
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.triggered.includes("stolen"));
  });

  test("L. selection falls through to the strongest supported candidate", () => {
    const ranked = [
      "Stolen AI Credits Are Funding a Black Market — Here's the Proof",  // shipped
      "I Bought AI Credits From a Broker — Here's What Happened",         // wildcard
      "AI Credits Are Being Resold for Profit — Here's How",              // supported
      "Token Brokers Explained",
    ];
    const r = selectFaithfulTitle(ranked, EVIDENCE, SEO.topicTitle);
    assert.equal(r.title, "AI Credits Are Being Resold for Profit — Here's How");
    assert.equal(r.usedBaseline, false);
    assert.equal(r.disqualified.length, 2);
  });

  test("with nothing supported it falls back to the topic baseline", () => {
    const r = selectFaithfulTitle(
      ["Stolen Credits Exposed", "The Fraud Nobody Reports"], EVIDENCE, SEO.topicTitle);
    assert.equal(r.usedBaseline, true);
    assert.equal(r.title, SEO.topicTitle);
  });

  test("the check runs between scoring and selection, before upload", () => {
    const seo = readFileSync("src/stages/seoGenerator.ts", "utf8");
    assert.ok(seo.indexOf("titleScoreSchema.parse") < seo.indexOf("selectFaithfulTitle("));
    assert.ok(seo.indexOf("selectFaithfulTitle(") < seo.indexOf("const primary ="));
    assert.match(seo, /const primary = faithful\.title;/);
    const pipeline = readFileSync("src/pipeline.ts", "utf8");
    assert.ok(pipeline.indexOf('name: "seoGenerator"') < pipeline.indexOf('name: "youtubeUpload"'));
  });
});
