import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { AssetLedger } from "../packages/pipeline-core/src/lib/visuals";
import {
  chooseAssemblyRepair,
} from "../packages/pipeline-core/src/stages/assemblyShared";
import type {
  RenderedBeat, AssemblyRepairOption,
} from "../packages/pipeline-core/src/stages/assemblyShared";
import {
  checkBrandFromMetadata, brandSubject,
} from "../packages/pipeline-core/src/lib/brandGuard";
import { scoreRelevance } from "../packages/pipeline-core/src/lib/visualRelevance";
import type { Candidate } from "../packages/pipeline-core/src/lib/visuals";

/**
 * Assembly can rearrange before it gives up.
 *
 * Feasibility has had a consecutive-card repair since 2026-08-16; assembly
 * never did. It carded a starved beat and moved on, so an arrangement
 * feasibility would have fixed for free became a FATAL
 * `no_consecutive_fallback_cards` AFTER narration was bought. Run
 * cmtvw27ix0001mbzyikvd7baz died exactly there: beats 8 and 9 carded from a
 * 599-asset pool with 4,483 characters already spent.
 *
 * These pin the decision, which is where feasibility's equivalent hid a missing
 * brand check for four months: it was buried inside a function that also
 * downloaded, cut and persisted, so nothing could test the conditions alone.
 */

const CH = "ai-doom-scroll" as const;
const SUBJECT = brandSubject("Automated plant floors", "Inside the modern factory.");

/** A beat about robots, naming no brand — so brand-relevance must come from the asset. */
const PLAIN_NARRATION =
  "Industrial robot arms now run the automated assembly line inside modern manufacturing plants, "
  + "and machine vision cameras inspect every part as it passes.";
/** A beat that genuinely discusses Nvidia, so Nvidia footage is supported here. */
const NVIDIA_NARRATION =
  "Nvidia ships these racks by the container load, and Nvidia says demand is still climbing.";

function candidate(assetId: string, description: string, durationS: number): Candidate {
  return {
    assetId, url: `https://videos.example/${assetId}.mp4`,
    width: 1920, height: 1080, durationS, provider: "pexels",
    pageUrl: `https://www.pexels.com/video/${assetId}/`, description,
  };
}

function beat(o: Partial<RenderedBeat> & { index: number; durationS: number }): RenderedBeat {
  return {
    startS: 0, endS: o.durationS, narration: PLAIN_NARRATION,
    assetId: null, assetDescription: null, assetUrl: null,
    sourceStartS: 0, sourceEndS: o.durationS, looped: false, reused: false,
    relevanceScore: null, concept: null,
    brand: {
      visibleBrandDetected: false, detectedBrandOrSignage: null,
      brandRelevantToNarration: null, brandDecision: "NO_BRAND",
      rejectionReason: null, source: "none",
    },
    decision: "RENDERED", clipPath: "/tmp/x.mp4", sceneNumber: o.index * 100 + 1,
    segmentIndex: 0, rawPath: `/tmp/raw-${o.index}.mp4`,
    ...o,
  } as RenderedBeat;
}

/** A rendered beat holding `asset`, on narration `narration`. */
function holding(index: number, c: Candidate, durationS: number, narration = PLAIN_NARRATION): RenderedBeat {
  return beat({
    index, durationS, narration,
    assetId: c.assetId, assetDescription: c.description ?? null,
    assetUrl: c.pageUrl ?? c.url,
  });
}

/** The carding beat that needs closing. */
function card(index: number, durationS: number, narration = PLAIN_NARRATION): RenderedBeat {
  return beat({
    index, durationS, narration, decision: "FALLBACK_CARD",
    concept: "card", rawPath: null,
  });
}

const rel = (b: RenderedBeat, description: string) => scoreRelevance({
  channel: CH, narration: b.narration, prompt: "automated assembly line robot arms", description,
});
const brandOn = (b: RenderedBeat, description: string, pageUrl: string) =>
  checkBrandFromMetadata(`${description} ${pageUrl}`, "automated assembly line robot arms", b.narration, SUBJECT);

const choose = (o: {
  target: RenderedBeat; rendered: RenderedBeat[]; globalPool: Candidate[];
  used?: string[];
}): AssemblyRepairOption | null => {
  const ledger = new AssetLedger(1);
  for (const id of o.used ?? []) ledger.claim(id);
  return chooseAssemblyRepair({
    target: o.target, rendered: o.rendered, globalPool: o.globalPool, ledger,
    rel, brandOn, hasSource: (b) => b.rawPath !== null,
  });
};

// ── The swap it is supposed to make ──────────────────────────────────────

describe("a repairable arrangement is repaired", () => {
  const longClip = candidate("long-1", "industrial robot arm on an automated assembly line", 40);
  const spare = candidate("spare-1", "machine vision camera inspecting parts on a line", 26);

  test("a long clip is moved onto the card and the donor is backfilled", () => {
    const donor = holding(3, longClip, 16);
    const target = card(8, 14);
    const pick = choose({
      target, rendered: [donor, target], globalPool: [longClip, spare],
      used: [longClip.assetId],
    });
    assert.ok(pick, "this arrangement is repairable");
    assert.equal(pick.donor.index, 3);
    assert.equal(pick.backfill.assetId, "spare-1");
  });

  test("the donated clip must close the card outright, not shrink it", () => {
    // 12s of source cannot cover a 14s card. Shrinking a card is not a repair:
    // the beat still carries a card and still fails the adjacency rule.
    const shortSrc = candidate("short-1", "industrial robot arm on an automated assembly line", 12);
    const donor = holding(3, shortSrc, 10);
    const pick = choose({
      target: card(8, 14), rendered: [donor], globalPool: [shortSrc, spare],
      used: [shortSrc.assetId],
    });
    assert.equal(pick, null);
  });

  test("the backfill must cover the donor's seconds EXACTLY", () => {
    // A 9s backfill against a 16s donor slot would leave the donor beat with a
    // 7s hole — a card of its own, and the timeline no longer adds up.
    const tooShort = candidate("tiny-1", "machine vision camera inspecting parts on a line", 9);
    const donor = holding(3, longClip, 16);
    const pick = choose({
      target: card(8, 14), rendered: [donor], globalPool: [longClip, tooShort],
      used: [longClip.assetId],
    });
    assert.equal(pick, null);
  });

  test("an already-used backfill is not offered — no asset appears twice", () => {
    const donor = holding(3, longClip, 16);
    const pick = choose({
      target: card(8, 14), rendered: [donor], globalPool: [longClip, spare],
      used: [longClip.assetId, spare.assetId],
    });
    assert.equal(pick, null);
  });

  test("a beat whose source is gone cannot donate", () => {
    // Nothing to re-cut from, and re-downloading would be a fresh acquisition.
    const donor = holding(3, longClip, 16);
    donor.rawPath = null;
    const pick = choose({
      target: card(8, 14), rendered: [donor], globalPool: [longClip, spare],
      used: [longClip.assetId],
    });
    assert.equal(pick, null);
  });

  test("a card never donates to another card", () => {
    const other = card(7, 16);
    const pick = choose({
      target: card(8, 14), rendered: [other], globalPool: [longClip, spare],
    });
    assert.equal(pick, null);
  });
});

// ── The brand guard, on both sides ───────────────────────────────────────

describe("a repair passes the brand guard, not only the relevance floor", () => {
  const nvidia = candidate("nv-1", "nvidia dgx server rack on an automated assembly line", 40);
  const plain = candidate("ok-1", "industrial robot arm on an automated assembly line", 40);
  const spare = candidate("spare-1", "machine vision camera inspecting parts on a line", 26);

  test("a donor branded for ITS beat is refused on a beat that cannot support it", () => {
    // The clip sits legitimately on beat 3, whose narration names Nvidia.
    // Beat 8 does not, and the video is not about Nvidia, so moving it there
    // would imply a connection the script never makes — and assembly, which
    // re-checks per beat, would refuse it and card the beat anyway.
    const donor = holding(3, nvidia, 16, NVIDIA_NARRATION);
    const pick = choose({
      target: card(8, 14), rendered: [donor], globalPool: [nvidia, spare],
      used: [nvidia.assetId],
    });
    assert.equal(pick, null, "the swap assembly would reject must not be offered");
  });

  test("the same donor IS offered to a beat that discusses the brand", () => {
    const donor = holding(3, nvidia, 16, NVIDIA_NARRATION);
    const target = card(8, 14, NVIDIA_NARRATION);
    const pick = choose({
      target, rendered: [donor], globalPool: [nvidia, spare],
      used: [nvidia.assetId],
    });
    assert.ok(pick, "branding supported by the beat is not a reason to refuse");
    assert.equal(pick.donor.assetId, "nv-1");
  });

  test("a branded BACKFILL is refused on the donor beat it would move into", () => {
    // Deliberately ON-BEAT for the donor's plain robot narration, so the ONLY
    // thing that can refuse it is the brand guard. An off-beat description
    // would make this test pass on relevance and prove nothing — the first
    // version of it did exactly that.
    const brandedSpare = candidate(
      "nv-2", "nvidia robot arm on an automated assembly line with machine vision", 26);
    const donor = holding(3, plain, 16);
    assert.ok(
      rel(donor, brandedSpare.description!).score >= 0.25,
      "fixture check: this backfill is relevant, so only branding can refuse it");
    const pick = choose({
      target: card(8, 14), rendered: [donor], globalPool: [plain, brandedSpare],
      used: [plain.assetId],
    });
    assert.equal(pick, null, "both sides of the swap are guarded, not just the donation");
  });

  test("subject branding is admitted everywhere, as it is in normal selection", () => {
    // A video ABOUT Nvidia may show Nvidia footage on every beat — the same
    // rule brandSubject() applies during ordinary assembly.
    const subjectVideo = brandSubject("Nvidia's new rack", "Nvidia just shipped it.");
    const donor = holding(3, nvidia, 16);
    const pick = chooseAssemblyRepair({
      target: card(8, 14), rendered: [donor], globalPool: [nvidia, spare],
      ledger: (() => { const l = new AssetLedger(1); l.claim(nvidia.assetId); return l; })(),
      rel,
      brandOn: (b, d, u) => checkBrandFromMetadata(
        `${d} ${u}`, "automated assembly line robot arms", b.narration, subjectVideo),
      hasSource: (b) => b.rawPath !== null,
    });
    assert.ok(pick);
  });
});

// ── Ranking ──────────────────────────────────────────────────────────────

describe("the best repair is taken first", () => {
  const spare = candidate("spare-1", "machine vision camera inspecting parts on a line", 26);

  test("non-brand-risk footage outranks a brand-risk aerial", () => {
    const aerial = candidate("air-1", "aerial view of a large industrial factory", 40);
    const ground = candidate("gnd-1", "industrial robot arm on an automated assembly line", 40);
    const pick = choose({
      target: card(8, 14),
      rendered: [holding(3, aerial, 16), holding(4, ground, 16)],
      globalPool: [aerial, ground, spare],
      used: [aerial.assetId, ground.assetId],
    });
    assert.ok(pick);
    assert.equal(pick.donor.assetId, "gnd-1", "the aerial is the brand-risk category");
    assert.equal(pick.brandRisk, false);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────

describe("the repair is wired into assembly, and the records follow the artifact", () => {
  const SRC = readFileSync("packages/pipeline-core/src/stages/assemblyShared.ts", "utf8");

  test("it runs after every beat is rendered and before the pacing invariants", () => {
    const call = SRC.indexOf("await repairAssemblyConsecutiveCards({");
    assert.ok(call > 0, "assembly must call the repair");
    assert.ok(call > SRC.indexOf("...(await renderBeat("),
      "a beat cannot donate before it has been rendered");
    assert.ok(call < SRC.indexOf("// ── Pacing invariants"),
      "the invariants must grade the repaired timeline");
  });

  test("it is one pass with no loop back into itself", () => {
    assert.equal((SRC.match(/await repairAssemblyConsecutiveCards\(\{/g) ?? []).length, 1,
      "a second call site would be an optimisation loop");
    const fn = SRC.slice(SRC.indexOf("async function repairAssemblyConsecutiveCards(input:"));
    const body = fn.slice(fn.indexOf("{"), fn.indexOf("\n/**"));
    assert.ok(!body.includes("repairAssemblyConsecutiveCards("), "it must not recurse");
  });

  test("stale scene records are cleared before the first beat is written", () => {
    const clear = SRC.indexOf("await clearSceneRecords(ctx.video.id)");
    assert.ok(clear > 0, "a re-render must not inherit the previous render's rows");
    assert.ok(clear < SRC.indexOf("...(await renderBeat("),
      "clearing after a beat was recorded would delete the row it just wrote");
  });

  test("a repaired beat reuses the card's scene number", () => {
    // Otherwise the RENDERED_FALLBACK row survives beside the clip that
    // replaced it, and no_consecutive_fallback_cards counts rows, not beats.
    const fn = SRC.slice(SRC.indexOf("async function repairAssemblyConsecutiveCards(input:"));
    assert.match(fn, /sceneNumber: target\.sceneNumber/,
      "the repair must overwrite the card's own row");
  });

  test("nothing is mutated before the new clips exist", () => {
    // A failed download or decode must leave the timeline exactly as it was,
    // not half-swapped with a clip path pointing at a file that is not there.
    const fn = SRC.slice(SRC.indexOf("async function repairAssemblyConsecutiveCards(input:"));
    const acquire = fn.indexOf("await downloadTo(backfill.url");
    const mutate = fn.indexOf("target.assetId = movedId");
    assert.ok(acquire > 0 && mutate > acquire, "acquire before commit");
    const cut = fn.indexOf("await cut(donor.rawPath!, need, targetClip)");
    assert.ok(cut > acquire && cut < mutate, "both clips are cut before either beat changes");
  });
});
