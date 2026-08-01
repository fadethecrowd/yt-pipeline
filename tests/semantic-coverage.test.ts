import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveRequirement, scoreSemantic, coverBeat, assessSemanticCoverage,
  resolveSense, MAX_CARD_SHARE,
} from "../packages/pipeline-core/src/lib/semanticCoverage";
import type { BeatRequirement } from "../packages/pipeline-core/src/lib/semanticCoverage";

/**
 * Beat-level semantic coverage controls.
 *
 * ai1r attempt 2 passed every numeric check — 117 assets, 2,006 usable
 * seconds, five concepts, largest 37% — with airport terminals, industrial
 * aerials, a hot-air balloon and tomatoes on a conveyor belt filling half the
 * timeline, and no supermarket footage at all. These fixtures pin the
 * distinction the numbers could not make: belonging to the right broad
 * concept is not the same as depicting what the sentence is about.
 */

const req = (visualPrompt: string, narration: string, highSalience = false): BeatRequirement =>
  deriveRequirement({ beatIndex: 0, segmentIndex: 0, narration, visualPrompt,
                      isHighSalience: highSalience });

const RETAIL_CAMERA = req(
  "Wide-angle shot looking down a long supermarket aisle from ceiling height, showing a dome security camera mounted above shelving units, shoppers pushing trolleys below",
  "That camera above the cereal aisle isn't just recording anymore.",
);
const SELF_CHECKOUT = req(
  "Close-up of a self-checkout station in a retail store with a security camera mounted on a pole above the machine",
  "Object detection flags items that never made it past the scanner.",
);
const CONTROL_ROOM = req(
  "Security operators watching a video wall inside a control room",
  "Operators watch dozens of camera feeds at once.",
);
const WAREHOUSE_CAMERA = req(
  "Ground-level shot inside a warehouse showing a packing station where a worker boxes items, with a security camera mounted above the workstation",
  "Cameras mounted at packing stations track worker hand movements.",
);
const VISION_PROCESSING = req(
  "Screen showing object detection bounding boxes drawn around people in a store camera feed",
  "The software draws a box around every person it sees and scores their behaviour.",
);

const verdict = (r: BeatRequirement, d: string) => scoreSemantic(r, d).verdict;

describe("named control cases", () => {
  test("retail-camera prompt vs supermarket camera asset → DIRECT", () => {
    assert.equal(
      verdict(RETAIL_CAMERA, "security camera mounted above a supermarket aisle with shelves"),
      "DIRECT",
    );
  });

  test("retail-camera prompt vs airport terminal → not DIRECT", () => {
    assert.notEqual(
      verdict(RETAIL_CAMERA, "people are walking through an airport terminal with luggage"),
      "DIRECT",
    );
  });

  test("self-checkout prompt vs generic warehouse aerial → not DIRECT", () => {
    assert.notEqual(
      verdict(SELF_CHECKOUT, "aerial view of large industrial warehouse facility"),
      "DIRECT",
    );
  });

  test("control-room prompt vs security video wall → DIRECT", () => {
    assert.equal(
      verdict(CONTROL_ROOM, "high tech control room with a video wall and operators monitoring"),
      "DIRECT",
    );
  });

  test("control-room prompt vs financial trading screens → not DIRECT", () => {
    assert.notEqual(
      verdict(CONTROL_ROOM, "financial trading data on screens in dark room"),
      "DIRECT",
    );
  });

  test("warehouse-camera prompt vs packing station with visible camera → DIRECT", () => {
    assert.equal(
      verdict(WAREHOUSE_CAMERA,
        "security camera mounted above a packing station in a warehouse where a worker boxes items"),
      "DIRECT",
    );
  });

  test("warehouse-camera prompt vs exterior industrial aerial → not DIRECT", () => {
    assert.notEqual(
      verdict(WAREHOUSE_CAMERA, "aerial view of industrial warehouse roofs with solar panels"),
      "DIRECT",
    );
  });

  test("vision-processing beat vs relevant monitoring interface → DIRECT", () => {
    assert.equal(
      verdict(VISION_PROCESSING,
        "object detection bounding box overlay on a retail store camera feed"),
      "DIRECT",
    );
  });

  test("vision-processing beat vs python package installation → not DIRECT", () => {
    assert.notEqual(
      verdict(VISION_PROCESSING, "downloading python packages on terminal screen"),
      "DIRECT",
    );
  });

  test("surveillance beat vs sound-processing software → not DIRECT", () => {
    assert.notEqual(
      verdict(CONTROL_ROOM, "close up sound processing software on a screen"),
      "DIRECT",
    );
  });

  test("the other observed false positives are all rejected", () => {
    for (const d of [
      "drone shot of a tall building",
      "drone video of a hot air balloon flying over an industrial park",
      "tomatoes on a conveyor belt",
      "graphs and charts printed on paper",
      "a large screen with many different colors",
      "aerial view of industrial park and warehouse area",
    ]) {
      assert.notEqual(verdict(RETAIL_CAMERA, d), "DIRECT", `${d} must not cover a retail beat`);
    }
  });
});

describe("polysemy is resolved from context, not per-topic exceptions", () => {
  test('"terminal" — computing vs transit vs payment', () => {
    assert.equal(resolveSense("downloading python packages on terminal screen", "terminal")?.sense,
                 "computing");
    assert.equal(resolveSense("busy airport terminal with passengers and luggage", "terminal")?.sense,
                 "transit");
    assert.equal(resolveSense("card payment terminal at a shop checkout", "terminal")?.sense,
                 "payment");
  });

  test('"monitor" — a display vs the act of monitoring', () => {
    assert.equal(resolveSense("office desk with a computer monitor and screen", "monitor")?.sense,
                 "display");
    assert.equal(
      resolveSense("police officer monitoring security camera in a control room", "monitor")?.sense,
      "watching",
    );
  });

  test('"camera" — security vs photography', () => {
    assert.equal(resolveSense("dome security camera mounted on a ceiling", "camera")?.sense,
                 "security");
    assert.equal(resolveSense("photographer with a dslr camera and tripod in a studio", "camera")?.sense,
                 "photography");
  });

  test('"checkout" and "tracking" disambiguate too', () => {
    assert.equal(resolveSense("self checkout till and scanner in a supermarket", "checkout")?.sense,
                 "retail");
    assert.equal(resolveSense("tracking a person with a surveillance camera", "tracking")?.sense,
                 "surveillance");
    assert.equal(resolveSense("tracking a parcel shipment for delivery", "tracking")?.sense,
                 "logistics");
  });

  test("an unresolvable word contributes nothing rather than guessing", () => {
    assert.equal(resolveSense("a terminal", "terminal"), null);
  });
});

describe("beat coverage requires directly relevant footage", () => {
  const opts = { beatMaxS: 30, minFragmentS: 3 };

  test("a beat with only off-target footage is not supported", () => {
    const c = coverBeat(RETAIL_CAMERA, 20, [
      { assetId: "a", description: "airport terminal with passengers", durationS: 20 },
      { assetId: "b", description: "aerial view of industrial warehouse", durationS: 20 },
    ], opts);
    assert.equal(c.supported, false);
    assert.equal(c.directCandidates.length, 0);
    assert.equal(c.rejected.length, 2);
  });

  test("a beat with genuine footage is supported", () => {
    const c = coverBeat(RETAIL_CAMERA, 20, [
      { assetId: "a", description: "security camera above a supermarket aisle with shelves", durationS: 25 },
    ], opts);
    assert.equal(c.supported, true);
    assert.equal(c.relevantSeconds, 25);
  });

  test("total pool size cannot rescue a beat — coverage is per beat", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      assetId: `x${i}`, description: "aerial view of industrial warehouse", durationS: 30,
    }));
    const c = coverBeat(RETAIL_CAMERA, 20, many, opts);
    assert.equal(c.supported, false, "100 irrelevant assets still cover nothing");
  });

  test("assets claimed by an earlier beat cannot be reused", () => {
    const claimed = new Set(["a"]);
    const c = coverBeat(RETAIL_CAMERA, 20, [
      { assetId: "a", description: "security camera above a supermarket aisle", durationS: 25 },
    ], { ...opts, claimed });
    assert.equal(c.supported, false, "reuse across beats is forbidden");
  });

  test("brand-risk footage cannot be what makes a beat coverable", () => {
    const c = coverBeat(RETAIL_CAMERA, 20, [
      { assetId: "a", description: "security camera above a supermarket aisle", durationS: 25,
        brandRisk: true },
    ], opts);
    assert.equal(c.supported, false);
    assert.ok(c.relevantSeconds >= 20 && c.nonBrandRiskSeconds < 20);
  });

  test("insufficient duration is not coverable even when relevant", () => {
    const c = coverBeat(RETAIL_CAMERA, 20, [
      { assetId: "a", description: "security camera above a supermarket aisle", durationS: 6 },
    ], opts);
    assert.equal(c.supported, false, "6s cannot fill a 20s beat without looping");
  });
});

describe("the whole-script gate fails closed", () => {
  const opts = { beatMaxS: 30, minFragmentS: 3 };
  const good = (id: string) => coverBeat(RETAIL_CAMERA, 20, [
    { assetId: id, description: "security camera above a supermarket aisle", durationS: 25 },
  ], opts);
  const bad = (r = RETAIL_CAMERA) => coverBeat(r, 20, [
    { assetId: "junk", description: "airport terminal with passengers", durationS: 25 },
  ], opts);

  test("all beats supported → pass", () => {
    const f = assessSemanticCoverage([good("a"), good("b"), good("c")]);
    assert.equal(f.pass, true);
    assert.equal(f.supportedBeats, 3);
  });

  test("a high-salience beat with no footage is unsupported, not carded", () => {
    const opener = req(
      "supermarket aisle with a dome security camera above the shelves",
      "That camera above the cereal aisle isn't just recording anymore.", true,
    );
    const f = assessSemanticCoverage([bad(opener), good("b"), good("c")]);
    assert.equal(f.pass, false);
    assert.equal(f.unsupportedBeats, 1);
    assert.match(f.failureReason!, /no directly relevant footage/);
  });

  test("card share above the cap fails", () => {
    const f = assessSemanticCoverage([bad(), bad(), good("a"), good("b"), good("c")]);
    assert.equal(f.pass, false);
    assert.ok(f.cardPct > MAX_CARD_SHARE);
  });

  test("consecutive cards fail", () => {
    const beats = [good("a"), bad(), bad(), ...Array.from({ length: 16 }, (_, i) => good(`g${i}`))];
    const f = assessSemanticCoverage(beats);
    assert.equal(f.consecutiveCards, true);
    assert.equal(f.pass, false);
  });

  test("the semantic card cap is the SAME 15% as the numeric gate", async () => {
    const v = await import("../packages/pipeline-core/src/lib/visualFeasibility");
    assert.equal(MAX_CARD_SHARE, v.MAX_CARD_SHARE);
    assert.equal(v.MAX_CONCEPT_SHARE, 0.4);
  });
});

describe("requirement derivation reads prompt and narration together", () => {
  test("a retail-camera beat requires both a camera and a retail setting", () => {
    assert.ok(RETAIL_CAMERA.primarySubjects.includes("security-camera"));
    assert.ok(RETAIL_CAMERA.settings.includes("retail-space"));
  });

  test("screens are disallowed unless the narration is about software", () => {
    assert.equal(RETAIL_CAMERA.screensAllowed, false);
    assert.ok(RETAIL_CAMERA.disallowed.includes("software-screen"));
    assert.equal(VISION_PROCESSING.screensAllowed, true);
    assert.ok(!VISION_PROCESSING.disallowed.includes("software-screen"));
  });
});
