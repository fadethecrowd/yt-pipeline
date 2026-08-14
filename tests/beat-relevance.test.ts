import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  scoreRelevance, conceptProfile, classifyConcept, AI_SUBJECTS, MARINE_SUBJECTS,
  REJECT_THRESHOLD, MAX_CONCEPT_SHARE, FEASIBILITY_POLICY,
} from "@yt-pipeline/pipeline-core";

/**
 * Does this clip illustrate THIS beat — or is it merely tech-adjacent?
 *
 * Qualification video #1 was good enough that the only content complaint was
 * visual relevance: a robotics story showed traffic-camera control rooms, audio
 * mixers, library shelves and a call centre. The scoring explains why. Subject
 * evidence was worth up to 0.75 for matching ANY AI_SUBJECTS bucket, with no
 * requirement that the bucket had anything to do with the beat, so the question
 * being answered was "is this asset AI-ish?".
 *
 * Measured over the 38 clips that shipped: 36 carried a concept absent from
 * their own beat, 30 of those scored STRONG, and on a robotics beat
 * "high tech control room with multiple cctv monitors" scored 0.96 while
 * "a robot with a happy face" scored 0.56. The CCTV outranked the robot.
 *
 * Fix: subject credit is full only when the asset's concept appears in the
 * BEAT's own concept profile, and a quarter otherwise. The demotion is
 * deliberately sized so that off-beat subject evidence alone (3 × 0.0625 =
 * 0.19) cannot clear REJECT_THRESHOLD 0.25 — an adjacent clip has to actually
 * agree with the beat's words to get in, rather than arriving on topic
 * membership alone.
 *
 * Every fixture below is a real Pexels description from video #1.
 */

const ROBOT_BEAT = {
  prompt: "A robotic arm mounted on a workbench in a research lab, surrounded by cables and control boxes, with an engineer adjusting it",
  narration: "What if you could teach a robot to do a physical task, train it with AI, and deploy it without switching tools. It is changing how engineers think about robotics development.",
};
const SURVEILLANCE_BEAT = {
  prompt: "A security operations centre with staff at monitoring stations reviewing wall-mounted screens",
  narration: "Traffic cameras and city-wide surveillance monitoring feeds are watched around the clock from a control room.",
};
const STORAGE_BEAT = {
  prompt: "Wide shot inside a large data center facility showing rows of server racks with blinking lights",
  narration: "Hugging Face Storage Buckets is cloud storage that plugs into the hub, so datasets and model artifacts live in one place.",
};
const SECURITY_BEAT = {
  prompt: "A security operations centre with analysts watching network monitoring dashboards",
  narration: "Mass vulnerability scanning is detected by security teams watching network monitoring dashboards for anomalies.",
};

const ai = (description: string, beat: { prompt: string; narration: string }) =>
  scoreRelevance({ channel: "ai-doom-scroll" as never, ...beat, description });

// ── The beat knows what it is about ──────────────────────────────────────

describe("a beat carries several concepts, not one", () => {
  test("conceptProfile keeps the runners-up classifyConcept discards", () => {
    const top = classifyConcept(`${ROBOT_BEAT.prompt} ${ROBOT_BEAT.narration}`, AI_SUBJECTS).concept;
    const profile = conceptProfile(`${ROBOT_BEAT.prompt} ${ROBOT_BEAT.narration}`, AI_SUBJECTS)
      .map((c) => c.concept);
    // The single winner was `research` — true, and useless for knowing the
    // beat is about robots.
    assert.equal(top, "research");
    assert.ok(profile.includes("robotics"),
      "the profile must retain robotics, which the single label threw away");
    assert.ok(profile.includes("research"));
  });

  test("it is ordered strongest first and drops zero-evidence concepts", () => {
    const p = conceptProfile("industrial robot arm on an assembly line", AI_SUBJECTS);
    assert.ok(p.length > 0);
    assert.ok(p.every((c) => c.score > 0));
    for (let i = 1; i < p.length; i++) assert.ok(p[i - 1].score >= p[i].score);
  });
});

// ── Robotics beat: direct beats adjacent ─────────────────────────────────

describe("a robotics beat prefers robots", () => {
  const ROBOTS = [
    "industrial robot arm in high tech factory",
    "humanoid robot moving",
    "robot that hand writes letters using ai",
    "a robot with a happy face",
  ];
  const TANGENTIAL = [
    "high tech control room with multiple cctv monitors",
    "high tech control room with traffic monitoring",
    "a sound engineer using an audio mixer",
    "professional audio mixer with hands adjusting knobs",
    "male call center agent taking notes",
    "woman picking book in a library",
  ];

  test("every robot clip stays admissible", () => {
    for (const d of ROBOTS) {
      const r = ai(d, ROBOT_BEAT);
      assert.notEqual(r.verdict, "REJECT", `${d} scored ${r.score}`);
    }
  });

  test("the gap between robots and tangential footage is closed, not merely nudged", () => {
    const robots = ROBOTS.map((d) => ai(d, ROBOT_BEAT).score);
    const tangential = TANGENTIAL.map((d) => ai(d, ROBOT_BEAT).score);
    const bestRobot = Math.max(...robots);
    const bestTangential = Math.max(...tangential);
    assert.ok(bestRobot > bestTangential + 0.3,
      `best robot ${bestRobot.toFixed(2)} must clearly lead ${bestTangential.toFixed(2)}`);
    // Median matters more than the extreme: selection is first-fit down a
    // sorted list, so what counts is that robots populate the top of it.
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    assert.ok(med(robots) > med(tangential),
      `median robot ${med(robots).toFixed(2)} vs median tangential ${med(tangential).toFixed(2)}`);
  });

  test("a thinly-described on-beat clip can still trail a richly-described off-beat one", () => {
    // Stated rather than tuned away. "robot that hand writes letters using ai"
    // carries one weak subject term; "high tech control room with multiple
    // cctv monitors" carries three, so even at a quarter weight the off-beat
    // clip retains comparable evidence — 0.38 against 0.40.
    //
    // That is a known limit of lexical scoring, not a defect introduced here,
    // and it is now a tie rather than the 0.96-to-0.56 rout it was. The clips
    // that describe themselves well — robot arm 0.88, humanoid 0.63, happy-face
    // robot 0.51 — all clear every tangential clip outright.
    const weakRobot = ai("robot that hand writes letters using ai", ROBOT_BEAT).score;
    const richCctv = ai("high tech control room with multiple cctv monitors", ROBOT_BEAT).score;
    assert.ok(Math.abs(weakRobot - richCctv) < 0.1,
      `now within noise (${weakRobot.toFixed(2)} vs ${richCctv.toFixed(2)}) rather than 0.40 apart`);
    assert.ok(richCctv < 0.6, "and the off-beat clip must no longer read as STRONG");
    // The well-described robots are unambiguous.
    for (const d of ["industrial robot arm in high tech factory", "humanoid robot moving", "a robot with a happy face"]) {
      assert.ok(ai(d, ROBOT_BEAT).score > richCctv, `${d} must beat the CCTV clip`);
    }
  });

  test("the exact regression: CCTV no longer beats a robot arm", () => {
    const cctv = ai("high tech control room with multiple cctv monitors", ROBOT_BEAT);
    const arm = ai("industrial robot arm in high tech factory", ROBOT_BEAT);
    assert.ok(arm.score > cctv.score,
      `shipped as CCTV 0.96 vs arm 0.88; now arm ${arm.score.toFixed(2)} vs CCTV ${cctv.score.toFixed(2)}`);
    assert.ok(cctv.score < 0.6, "the CCTV clip must no longer read as STRONG");
  });

  test("the reason says why, so a reviewer can answer 'why is this here?'", () => {
    const off = ai("high tech control room with multiple cctv monitors", ROBOT_BEAT);
    assert.ok(off.reasons.some((r) => /not in this beat/.test(r)));
    const on = ai("industrial robot arm in high tech factory", ROBOT_BEAT);
    assert.ok(on.reasons.some((r) => /is what this beat is about/.test(r)));
  });
});

// ── The same clip is judged per beat, not banned globally ────────────────

describe("context decides — the same footage is right elsewhere", () => {
  test("traffic-camera footage is DIRECT for an actual surveillance beat", () => {
    const d = "high tech control room with traffic monitoring";
    assert.ok(ai(d, SURVEILLANCE_BEAT).score > ai(d, ROBOT_BEAT).score,
      "identical clip must score higher where the beat is about monitoring");
    assert.notEqual(ai(d, SURVEILLANCE_BEAT).verdict, "REJECT");
  });

  test("a SOC/control room remains valid for a cybersecurity beat", () => {
    const r = ai("modern control room monitoring operations", SECURITY_BEAT);
    assert.notEqual(r.verdict, "REJECT");
  });

  test("data-centre footage is valid for the storage beat of a robotics story", () => {
    // Not every beat of a robotics video should show robots.
    const r = ai("data center server room with racks", STORAGE_BEAT);
    assert.notEqual(r.verdict, "REJECT");
    assert.ok(r.score > ai("data center server room with racks", ROBOT_BEAT).score);
  });

  test("surveillance is not penalised as a category — only off-beat use is", () => {
    const onBeat = ai("high tech control room in action", SURVEILLANCE_BEAT);
    assert.ok(onBeat.score >= 0.6, `on-beat control room should stay strong, got ${onBeat.score}`);
  });
});

// ── Not overcorrected ────────────────────────────────────────────────────

describe("adjacent footage is demoted, not banned", () => {
  test("off-beat subject evidence alone cannot clear the threshold", () => {
    // 3 × 0.0625 = 0.1875 < 0.25. This is the calibration anchor: an adjacent
    // clip must agree with the beat's words to be admitted at all.
    assert.equal(REJECT_THRESHOLD, 0.25);
    const r = ai("automated solar panel production line", ROBOT_BEAT);
    assert.ok(r.score < REJECT_THRESHOLD);
  });

  test("an off-beat clip that DOES echo the beat's words still survives", () => {
    // Demotion removes the free pass, not the ability to earn a place.
    const r = ai("engineer adjusting cables on a workbench in a lab", ROBOT_BEAT);
    assert.notEqual(r.verdict, "REJECT");
  });

  test("a beat naming nothing the taxonomy knows is not uniformly punished", () => {
    const odd = { prompt: "A calligrapher drawing ink strokes on paper", narration: "Handwriting varies enormously between people." };
    const before = scoreRelevance({ channel: "ai-doom-scroll" as never, ...odd, description: "industrial robot arm in high tech factory" });
    assert.ok(before.score > 0, "an empty beat profile must not zero every asset");
  });

  test("scoring stays deterministic — no jitter was introduced", () => {
    const a = ai("humanoid robot moving", ROBOT_BEAT);
    for (let i = 0; i < 4; i++) assert.equal(ai("humanoid robot moving", ROBOT_BEAT).score, a.score);
  });
});

// ── Nothing else moved ───────────────────────────────────────────────────

describe("surrounding policy is unchanged", () => {
  test("AI Doom dominant-concept stays diagnostic, Wet Circuit stays enforced", () => {
    assert.equal(FEASIBILITY_POLICY["ai-doom-scroll"].enforceDominantConceptCap, false);
    assert.equal(FEASIBILITY_POLICY["wet-circuit"].enforceDominantConceptCap, true);
    assert.equal(MAX_CONCEPT_SHARE, 0.4);
  });

  test("Wet Circuit scoring reads the marine taxonomy and still works", () => {
    const r = scoreRelevance({
      channel: "wet-circuit" as never,
      prompt: "A yacht on the water with marine electronics at the helm",
      narration: "The boat's sonar and chartplotter guide the vessel.",
      description: "marine chartplotter display on a helm",
    });
    assert.equal(r.concept, "electronics");
    assert.notEqual(r.verdict, "REJECT");
    assert.deepEqual(Object.keys(MARINE_SUBJECTS),
      ["vessel", "electronics", "water", "fishing", "install"]);
  });

  test("beat relevance applies to Wet Circuit consistently, not as a special case", () => {
    // The rule is channel-agnostic: it uses whichever taxonomy the channel
    // already uses, so WC gains the same beat-awareness without new policy.
    const off = scoreRelevance({
      channel: "wet-circuit" as never,
      prompt: "A yacht on the water with marine electronics at the helm",
      narration: "The boat's sonar and chartplotter guide the vessel.",
      description: "angler holding a fishing rod on a riverbank",
    });
    assert.ok(off.score < 0.75);
  });
});
