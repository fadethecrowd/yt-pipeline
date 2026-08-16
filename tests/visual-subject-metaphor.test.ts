import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  comparisonVehicles, deVehicle, isOutroBeat, subjectTerms,
  borrowedFromVehicle, withheldDomains,
} from "../packages/pipeline-core/src/lib/visualSubject";
import { classifyConcept, AI_SUBJECTS, MARINE_SUBJECTS } from "../packages/pipeline-core/src/lib/visualRelevance";

/**
 * An analogy's vehicle must not become the visual subject.
 *
 * Run e704334a explained token brokering by analogy to wholesale electricity
 * and commodity markets. The script generator wrote the ANALOGY into two
 * visual_prompts, retrieval faithfully returned warehouses, forklifts and a
 * rapeseed field, and the scorer passed them at 0.25-0.30 because ACCEPTABLE is
 * a passing verdict.
 *
 * The four pairings below are the ones a human picked out of the contact sheet.
 * Each asserts that the class of asset actually chosen would no longer be
 * retrieved for, or selected for, that narration.
 */

// The real script, verbatim from candidate cmsw5jcqb0002mb2kjg7a59vg.
const HOOK =
  "There's a shadow economy growing right underneath the AI boom, and most "
  + "people have no idea it exists. Imagine buying wholesale electricity, then "
  + "reselling it at a markup to your neighbors. Now replace electricity with AI "
  + "processing power, and you've got one of the fastest-growing arbitrage plays "
  + "in tech right now. We're talking about token brokers — middlemen who buy AI "
  + "credits in bulk and resell them for profit.";

const SEGMENTS = [
  { // 0 — analogy taken literally
    prompt: "A busy wholesale warehouse with workers moving large pallets of boxed goods, "
      + "shot from a wide angle showing the scale of inventory",
    narration: HOOK,
  },
  { // 1 — sound: the narration names law firms and document review
    prompt: "A law office with attorneys reviewing stacked paper documents spread across "
      + "a large conference table",
    narration: "Yes, startups with thin budgets use brokers to avoid the steep minimums "
      + "that direct enterprise contracts require. But brokers are also serving mid-sized "
      + "agencies, law firms automating document review, healthcare companies running "
      + "diagnostic tooling.",
  },
  { // 2 — sound enough: the narration is about pricing
    prompt: "A commodity trading floor with traders at standing desks rapidly reviewing "
      + "printed price sheets and making phone calls",
    narration: "Enterprise contracts with major AI providers can unlock discounts anywhere "
      + "from twenty to fifty percent off standard API pricing.",
  },
  { // 3 — sound: the narration is about businesses losing access
    prompt: "A small business owner standing in a closed storefront with a paper notice "
      + "taped to the locked glass door",
    narration: "If the broker's master account gets suspended your access can vanish "
      + "overnight with no recourse. This has already happened to real businesses.",
  },
  { // 4 — sound: the narration is about providers and contracts
    prompt: "A formal contract signing at a corporate boardroom table with two people "
      + "exchanging documents and shaking hands",
    narration: "Providers can't easily see what workloads are ultimately running on their "
      + "infrastructure when layers of intermediaries obscure the end user.",
  },
  { // 5 — analogy leaked, with no comparison frame of its own
    prompt: "An open-air agricultural commodity market with traders negotiating over "
      + "crates of produce in a large covered market hall",
    narration: "The token broker economy is still early, and the next phase looks "
      + "genuinely wild. As model providers multiply and competition intensifies, brokers "
      + "will increasingly aggregate across multiple providers simultaneously.",
  },
];

const SCRIPT = [HOOK, ...SEGMENTS.map((s) => s.narration)].join("\n");
const vehicles = comparisonVehicles(SCRIPT);

/** Would this segment's prompt be replaced before anything is retrieved? */
function replaced(i: number): boolean {
  const seg = SEGMENTS[i]!;
  const subjectText = deVehicle(seg.narration, vehicles);
  const withheld = withheldDomains(subjectText, AI_SUBJECTS);
  const asked = classifyConcept(seg.prompt, AI_SUBJECTS).concept;
  return borrowedFromVehicle(seg.prompt, vehicles).length > 0 || withheld.has(asked);
}

// ── The analogy itself ───────────────────────────────────────────────────

describe("the comparison's vehicle is identified and excised", () => {
  test("both frames in the hook are found", () => {
    assert.ok(vehicles.some((v) => v.includes("wholesale electricity")),
      `"imagine …" frame missing from ${JSON.stringify(vehicles)}`);
    assert.ok(vehicles.some((v) => v.trim() === "electricity"),
      "the 'replace X with' frame must yield X");
  });

  test("excision removes the analogy but keeps the subject", () => {
    const out = deVehicle(HOOK, vehicles);
    assert.ok(!out.includes("wholesale"), "the vehicle's vocabulary must not survive");
    assert.ok(out.includes("token brokers"), "the actual subject must survive");
    assert.ok(out.includes("AI processing power"),
      "'replace X with Y' must keep Y — Y is the subject");
  });

  test("longest span first, or the analogy survives its own excision", () => {
    // Removing "electricity" first destroys the longer span's text.
    const out = deVehicle("Imagine buying wholesale electricity, then reselling it.",
      ["electricity", "buying wholesale electricity, then reselling it"]);
    assert.ok(!out.includes("wholesale"), `left "${out}"`);
  });

  test("bare 'like' is not a comparison frame — the CTA says it every time", () => {
    assert.deepEqual(comparisonVehicles("hit the like button, it helps the channel"), []);
  });
});

// ── The four named pairings ──────────────────────────────────────────────

describe("the pairings a human picked out of the contact sheet", () => {
  test("scene 301/403 — 'shadow economy' must not retrieve a wholesale warehouse", () => {
    assert.ok(replaced(0), "segment 0's prompt must not survive to drive retrieval");
    assert.deepEqual(borrowedFromVehicle(SEGMENTS[0]!.prompt, vehicles), ["wholesale"],
      "and the reason must be that it reused the analogy's own word");
  });

  test("scene 2002 — 'token broker economy' must not retrieve a produce market", () => {
    // No borrowed vocabulary here: the analogy leaked without being restated,
    // so only the literal-domain rule can catch it.
    assert.deepEqual(borrowedFromVehicle(SEGMENTS[5]!.prompt, vehicles), []);
    assert.ok(replaced(5), "segment 5's prompt must not survive either");
    assert.equal(classifyConcept(SEGMENTS[5]!.prompt, AI_SUBJECTS).concept, "environment",
      "it is agricultural imagery that the narration never calls for");
  });

  test("scene 2101 — 'I read every comment' is an outro beat, not a search", () => {
    assert.ok(isOutroBeat("I read every comment and the best ones make it into future scripts."));
  });

  test("scene 2202 — 'Subscribe so you don't miss…' is an outro beat", () => {
    assert.ok(isOutroBeat("Subscribe so you don't miss our next deep dive into the "
      + "infrastructure layer that's quietly shaping how AI gets deployed."));
  });

  test("a rapeseed field and a warehouse are both withheld from these beats", () => {
    for (const i of [0, 5]) {
      const w = withheldDomains(deVehicle(SEGMENTS[i]!.narration, vehicles), AI_SUBJECTS);
      assert.ok(w.has("environment"), `segment ${i} must withhold farmland`);
      assert.ok(w.has("factory"), `segment ${i} must withhold warehouses`);
    }
  });
});

// ── It must not fire on prompts that were always fine ────────────────────

describe("sound prompts are left alone", () => {
  test("segments 1-4 keep their own prompts", () => {
    for (const i of [1, 2, 3, 4]) {
      assert.equal(replaced(i), false,
        `segment ${i} ("${SEGMENTS[i]!.prompt.slice(0, 40)}…") must not be replaced`);
    }
  });

  test("a domain the narration DOES name stays available", () => {
    // The rule withholds only what the narration cannot justify, so a genuinely
    // industrial story keeps its factories and a marine one keeps its boats.
    const industrial = withheldDomains(
      "Inside the factory, the assembly line runs day and night.", AI_SUBJECTS);
    assert.ok(!industrial.has("factory"));
    const marine = withheldDomains(
      "The boat rolled as the angler worked the water.", MARINE_SUBJECTS);
    assert.ok(!marine.has("vessel"), "a marine channel must keep its vessels");
  });

  test("ordinary editorial prose is not mistaken for an outro", () => {
    // "under-subscribed" contains "subscribe"; a substring test read this very
    // sentence — from segment 4 of the same script — as a CTA.
    assert.equal(isOutroBeat(
      "brokers are moving volume that might otherwise sit unused in "
      + "under-subscribed enterprise tiers"), false);
    assert.equal(isOutroBeat("The customers aren't who you'd expect."), false);
  });
});

// ── What gets searched for instead ───────────────────────────────────────

describe("the replacement subject comes from the narration", () => {
  test("it names the topic, not the analogy and not adverbs", () => {
    const terms = subjectTerms({ narration: SEGMENTS[0]!.narration, scriptText: SCRIPT });
    assert.ok(terms.includes("broker"), `got ${JSON.stringify(terms)}`);
    assert.ok(!terms.includes("wholesale"), "the analogy must not steer the search");
    assert.ok(!terms.includes("electricity"), "nor its subject");
    // Length-ranking put these ahead of "broker"; none names a filmable thing.
    for (const junk of ["underneath", "fastest-growing", "completely"]) {
      assert.ok(!terms.includes(junk), `"${junk}" is not a subject`);
    }
  });

  test("business/businesses still match after stemming", () => {
    // A blanket trailing-s strip made "business" and "businesses" disagree, and
    // segment 3 — whose prompt and narration BOTH say business — read as drift.
    const t = subjectTerms({
      narration: "This has already happened to real businesses.",
      scriptText: "businesses business business",
    });
    assert.ok(t.includes("business"), `got ${JSON.stringify(t)}`);
  });
});
