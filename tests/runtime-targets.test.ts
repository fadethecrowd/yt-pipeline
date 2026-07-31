import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeRange, checkRuntime, charsForRuntime, CONFIGURED_RANGE, OBSERVED_RANGE,
} from "../packages/pipeline-core/src/lib/runtimeTargets";

describe("runtime stage isolation", () => {
  test("DIAGNOSTIC long-form is the short 55–100s range", () => {
    const r = runtimeRange("ai-doom-scroll", "LONGFORM", "DIAGNOSTIC");
    assert.equal(r.minS, 55);
    assert.equal(r.maxS, 100);
  });

  test("the diagnostic range NEVER leaks into other stages", () => {
    for (const stage of ["QUALIFICATION", "RETEST", "REPEATABILITY", "PRODUCTION"] as const) {
      for (const ch of ["ai-doom-scroll", "wet-circuit"] as const) {
        const r = runtimeRange(ch, "LONGFORM", stage);
        assert.ok(r.minS >= 200, `${ch}/${stage} min ${r.minS}s is diagnostic-sized`);
        assert.ok(r.maxS > 100, `${ch}/${stage} max ${r.maxS}s is diagnostic-sized`);
      }
    }
  });

  test("a 76s diagnostic FAILS the qualification range", () => {
    const c = checkRuntime(76, "ai-doom-scroll", "LONGFORM", "QUALIFICATION");
    assert.equal(c.ok, false);
    assert.match(c.detail, /OUTSIDE/);
  });

  test("a diagnostic-length asset PASSES at DIAGNOSTIC stage", () => {
    assert.equal(checkRuntime(76, "ai-doom-scroll", "LONGFORM", "DIAGNOSTIC").ok, true);
  });

  test("qualification long-form targets match each channel's observed behaviour", () => {
    const ai = runtimeRange("ai-doom-scroll", "LONGFORM", "QUALIFICATION");
    assert.ok(ai.upperS >= OBSERVED_RANGE["ai-doom-scroll"].medianS);
    assert.ok(ai.upperS <= OBSERVED_RANGE["ai-doom-scroll"].maxS + 30);
    const wc = runtimeRange("wet-circuit", "LONGFORM", "QUALIFICATION");
    assert.ok(wc.upperS >= OBSERVED_RANGE["wet-circuit"].medianS);
    assert.ok(wc.upperS <= OBSERVED_RANGE["wet-circuit"].maxS + 30);
  });

  test("upper-end target exceeds mid target", () => {
    for (const ch of ["ai-doom-scroll", "wet-circuit"] as const) {
      const r = runtimeRange(ch, "LONGFORM", "QUALIFICATION");
      assert.ok(r.upperS > r.midS, `${ch}: upper ${r.upperS} must exceed mid ${r.midS}`);
    }
  });
});

describe("Shorts runtime", () => {
  test("Shorts range is YouTube-compliant regardless of stage", () => {
    for (const stage of ["DIAGNOSTIC", "QUALIFICATION", "PRODUCTION"] as const) {
      const r = runtimeRange("ai-doom-scroll", "SHORT", stage);
      assert.ok(r.maxS <= 60, "Shorts must stay within the classic 60s form");
      assert.ok(r.minS >= 15);
    }
  });
  test("a 61s Short fails", () => {
    assert.equal(checkRuntime(61, "wet-circuit", "SHORT", "QUALIFICATION").ok, false);
  });
  test("a 45s Short passes", () => {
    assert.equal(checkRuntime(45, "wet-circuit", "SHORT", "QUALIFICATION").ok, true);
  });
});

describe("character budgeting", () => {
  test("longer targets need more characters", () => {
    assert.ok(charsForRuntime("ai-doom-scroll", 450) > charsForRuntime("ai-doom-scroll", 360));
  });
  test("rates are channel-specific", () => {
    assert.notEqual(charsForRuntime("ai-doom-scroll", 300), charsForRuntime("wet-circuit", 300));
  });
  test("documented config drift is recorded for both channels", () => {
    // Wet Circuit's configured 6–8min has never been met; AI Doom's 3–6min is
    // exceeded in practice. Both are recorded so the drift stays visible.
    assert.ok(CONFIGURED_RANGE["wet-circuit"].minS > OBSERVED_RANGE["wet-circuit"].maxS,
      "WC config floor should exceed its observed ceiling — the documented drift");
    assert.ok(OBSERVED_RANGE["ai-doom-scroll"].maxS > CONFIGURED_RANGE["ai-doom-scroll"].maxS,
      "AI Doom observed max should exceed its config max — the documented drift");
  });
});
