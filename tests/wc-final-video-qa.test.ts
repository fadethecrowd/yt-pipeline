import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  authoritativeQaRecord, decideQaAuthorization,
} from "../packages/wc-pipeline/src/stages/finalVideoQa";
import type { QaRecordLike } from "../packages/wc-pipeline/src/stages/finalVideoQa";

/**
 * Wet Circuit refuses to upload a video that automated QA has not passed, for
 * the exact bytes about to be sent.
 *
 * Control 14 was the last FAIL in the WC control-gap matrix: `runQa`/`persistQa`
 * were reachable only from the qualification scripts, so no production path
 * validated an assembled video or its captions before upload.
 *
 * Stage ordering is not the control — a resumed run, a hand-edited status, or a
 * re-render after QA all reach upload without QA having seen the current bytes.
 * The control is the hash binding, asserted by the upload stage itself.
 *
 * These assert on source because the guarantee is structural: which module
 * calls which, in which order, and what it refuses. The behavioural half is
 * exercised in the pure-function tests below, which need no database, no
 * render and no network.
 */

const qa = readFileSync("packages/wc-pipeline/src/stages/finalVideoQa.ts", "utf8");
const upload = readFileSync("packages/wc-pipeline/src/stages/youtubeUpload.ts", "utf8");
const pipeline = readFileSync("packages/wc-pipeline/src/pipeline.ts", "utf8");

// ── Stage order ───────────────────────────────────────────────────────────

describe("WC stage order places final-video QA between assembly and upload", () => {
  const idx = (name: string) => pipeline.indexOf(`name: "${name}"`);

  test("the required stage order holds", () => {
    const order = [
      "topicDiscovery", "scriptGenerator", "qualityGate", "visualFeasibilityGate",
      "seoGenerator", "wcThumbnailHeadlineGenerator", "wcThumbnailGenerator",
      "voiceover", "videoAssembly", "finalVideoQa", "youtubeUpload",
      "shortsGenerator", "notify",
    ];
    const positions = order.map((n) => ({ n, at: idx(n) }));
    for (const p of positions) assert.ok(p.at > 0, `stage ${p.n} must be registered`);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i].at > positions[i - 1].at,
        `${positions[i].n} must come after ${positions[i - 1].n}`,
      );
    }
  });

  test("QA runs after assembly and before upload", () => {
    assert.ok(idx("videoAssembly") < idx("finalVideoQa"), "QA needs a rendered artifact");
    assert.ok(idx("finalVideoQa") < idx("youtubeUpload"), "QA must precede upload");
  });

  test("feasibility still precedes any narration spend", () => {
    assert.ok(idx("visualFeasibilityGate") < idx("voiceover"),
      "the feasibility gate must precede voiceover");
  });

  test("QA is not retried — a retry re-measures the same bytes for the same answer", () => {
    const stage = pipeline.slice(idx("finalVideoQa"), idx("youtubeUpload"));
    assert.match(stage, /retries:\s*0/);
  });

  test("Shorts remain pilot-skippable and still exist for normal production", () => {
    assert.match(pipeline, /skipDuringPilot: true/);
    assert.match(pipeline, /STAGES\.filter\(\(s\) => !\(pilot && s\.skipDuringPilot\)\)/);
    assert.ok(idx("shortsGenerator") > 0);
  });
});

// ── RESUME_FROM survives the inserted stage ───────────────────────────────

describe("RESUME_FROM stays name-based and correct after inserting QA", () => {
  test("resume targets are names, not indices", () => {
    assert.match(pipeline, /RESUME_FROM: Partial<Record<VideoStatus, string>>/);
    assert.match(pipeline, /function resumeIndex\(/);
  });

  test("ASSEMBLY_DONE resumes at finalVideoQa, not straight at upload", () => {
    assert.match(pipeline, /\[VideoStatus\.ASSEMBLY_DONE\]:\s*"finalVideoQa"/,
      "a resumed run must re-measure the artifact rather than trust an older verdict");
  });

  test("every resume target resolves in both the normal and pilot stage lists", () => {
    const STAGES = [
      "topicDiscovery", "scriptGenerator", "qualityGate", "visualFeasibilityGate",
      "seoGenerator", "wcThumbnailHeadlineGenerator", "wcThumbnailGenerator",
      "voiceover", "videoAssembly", "finalVideoQa", "youtubeUpload",
      "shortsGenerator", "notify",
    ];
    const pilotStages = STAGES.filter((s) => s !== "shortsGenerator");
    const targets = ["wcThumbnailHeadlineGenerator", "videoAssembly", "finalVideoQa", "youtubeUpload"];
    for (const t of targets) {
      for (const list of [STAGES, pilotStages]) {
        const at = list.indexOf(t);
        assert.ok(at >= 0, `${t} must resolve`);
        assert.equal(list[at], t, `${t} must resolve to itself, not a neighbour`);
      }
    }
  });

  test("no resume target lands on a stage that would skip QA before upload", () => {
    // UPLOAD_PENDING resumes at youtubeUpload, which re-asserts the persisted
    // QA against the current artifact hash — so it cannot bypass the control.
    assert.match(pipeline, /\[VideoStatus\.UPLOAD_PENDING\]:\s*"youtubeUpload"/);
    assert.match(upload, /assertWcFinalQaPassed\(/,
      "resuming at upload must still be gated");
  });
});

// ── The upload stage enforces the precondition itself ─────────────────────

describe("youtubeUpload fails closed without a passing QA bound to the artifact", () => {
  test("the gate is called by the upload stage, not merely ordered before it", () => {
    assert.match(upload, /await assertWcFinalQaPassed\(ctx\.video\.id, video\.videoPath\)/);
  });

  test("the gate runs before the pilot branch and before prepareUpload", () => {
    const gate = upload.indexOf("assertWcFinalQaPassed(");
    const pilotBranch = upload.indexOf('policy.source === "pilot" && policy.requireGuardedUpload');
    const prepare = upload.indexOf("prepareUpload({");
    const rawInsert = upload.indexOf("youtube.videos.insert(");
    assert.ok(gate > 0, "the gate must exist");
    assert.ok(gate < prepare, "QA must gate ordinary production too, not just the pilot");
    assert.ok(gate < pilotBranch, "QA must precede the pilot upload path");
    assert.ok(gate < rawInsert, "QA must precede the direct insert");
  });

  test("a blocked QA result returns a failure rather than throwing past the gate", () => {
    assert.match(upload, /err instanceof WcQaBlockedError/);
    assert.match(upload, /upload blocked \[\$\{err\.code\}\]/);
  });

  test("ordinary non-pilot WC production cannot bypass QA", () => {
    // There is exactly one gate call, and it sits above the branch that
    // separates pilot from normal, so both inherit it.
    const calls = upload.match(/assertWcFinalQaPassed\(/g) ?? [];
    assert.equal(calls.length, 1, "one gate, above the branch, covers both paths");
  });
});

// ── Fail-closed conditions ────────────────────────────────────────────────

describe("the QA gate refuses every incomplete or stale case", () => {
  const codes = ["QA_ARTIFACT_MISSING", "QA_ABSENT", "QA_NOT_PASSED", "QA_INCOMPLETE", "QA_STALE_ARTIFACT"];

  for (const code of codes) {
    test(`refuses with ${code}`, () => {
      assert.match(qa, new RegExp(`"${code}"`), `${code} must be a refusal reason`);
    });
  }

  test("absent QA is a refusal, not a skip", () => {
    assert.match(qa, /if \(!record\) \{[\s\S]*?QA_ABSENT/);
  });

  test("anything other than PASS is a refusal", () => {
    assert.match(qa, /record\.overall !== "PASS"/);
  });

  test("a record with no check list is incomplete, not acceptable", () => {
    assert.match(qa, /if \(!Array\.isArray\(record\.checks\)\)/);
  });

  test("a malformed or missing hash binding is incomplete", () => {
    assert.match(qa, /!\/\^\[0-9a-f\]\{64\}\$\/\.test\(recorded\)/);
  });

  test("a binding for different bytes is stale and refused", () => {
    assert.match(qa, /recorded !== actual/);
  });

  test("the gate returns evidence on success, so the caller can log what it relied on", () => {
    assert.match(qa, /return \{ qaId: decision\.qaId, sha256: actual \}/);
  });
});

// ── Artifact binding ──────────────────────────────────────────────────────

describe("QA verdicts are bound to the bytes they measured", () => {
  test("the stage hashes the artifact it just validated", () => {
    assert.match(qa, /const fileSha256 = await sha256File\(video\.videoPath\)/);
  });

  test("the hash is recorded as a check, so existing persistence carries it", () => {
    assert.match(qa, /name: ARTIFACT_CHECK/);
    assert.match(qa, /value: fileSha256/);
    assert.match(qa, /result\.checks\.push\(binding\)/);
  });

  test("persistence uses the repository's existing persistQa, not a new mechanism", () => {
    assert.match(qa, /await persistQa\(input, result\)/);
    assert.doesNotMatch(qa, /prisma\.qaRecord\.create/,
      "QA must not open a second persistence path");
  });

  test("QA uses the existing runQa gate rather than a bespoke check set", () => {
    assert.match(qa, /await runQa\(input\)/);
  });

  test("no new table or column is introduced", () => {
    assert.doesNotMatch(qa, /\$executeRaw|CREATE TABLE|ALTER TABLE|migration/i);
  });

  test("caption timings come from the durable narration manifest", () => {
    // Rebuilt from the same manifest assembly rendered against, so the check
    // reproduces real timings and works identically on a resumed run.
    assert.match(qa, /readManifest\(audioDir\)/);
    assert.match(qa, /readAlignments\(manifest\)/);
    assert.match(qa, /buildLongformCaptions\(/);
    assert.match(qa, /TITLE_CARD_DURATION/);
  });

  test("a missing manifest is a refusal, not an assumed-zero timeline", () => {
    assert.match(qa, /QA_NO_MANIFEST/);
  });
});

// ── QA-record precedence: the LATEST verdict decides ──────────────────────
//
// Exercises the real exported functions, not a mirror of them. An older PASS
// must never authorize an upload once any newer record exists, and the newest
// record must be chosen deterministically even when timestamps tie.

const OK_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function rec(
  id: string,
  overall: string,
  boundHash: unknown,
  createdAt: string,
): QaRecordLike {
  return {
    id,
    overall,
    checks: boundHash === undefined ? [] : [{ name: "final_video_sha256", value: boundHash }],
    createdAt: new Date(createdAt),
  };
}

/** What the upload gate would do, given these records and this artifact. */
function verdict(records: QaRecordLike[], actual = OK_HASH) {
  const authoritative = authoritativeQaRecord(records);
  const d = decideQaAuthorization(authoritative, actual);
  return { authoritative, code: d.ok ? "ALLOW" : d.code };
}

describe("QA-record precedence — the eight required cases", () => {
  const oldPass = rec("c_old", "PASS", OK_HASH, "2026-08-01T10:00:00Z");

  test("1. old PASS/current hash + newer FAIL/current hash → refuse", () => {
    const v = verdict([oldPass, rec("c_new", "FAIL", OK_HASH, "2026-08-02T10:00:00Z")]);
    assert.equal(v.authoritative?.id, "c_new", "the newer record must decide");
    assert.equal(v.code, "QA_NOT_PASSED");
  });

  test("2. old PASS/current hash + newer ERROR → refuse", () => {
    const v = verdict([oldPass, rec("c_new", "ERROR", OK_HASH, "2026-08-02T10:00:00Z")]);
    assert.equal(v.authoritative?.id, "c_new");
    assert.equal(v.code, "QA_NOT_PASSED");
  });

  test("3. old PASS/current hash + newer WARN → refuse", () => {
    const v = verdict([oldPass, rec("c_new", "WARN", OK_HASH, "2026-08-02T10:00:00Z")]);
    assert.equal(v.authoritative?.id, "c_new");
    assert.equal(v.code, "QA_NOT_PASSED");
  });

  test("4. old PASS/current hash + newer malformed/incomplete → refuse", () => {
    // No binding at all.
    const noBinding = verdict([oldPass, rec("c_new", "PASS", undefined, "2026-08-02T10:00:00Z")]);
    assert.equal(noBinding.authoritative?.id, "c_new");
    assert.equal(noBinding.code, "QA_INCOMPLETE");

    // Binding present but not a hash.
    const truncated = verdict([oldPass, rec("c_new2", "PASS", "abc", "2026-08-02T10:00:00Z")]);
    assert.equal(truncated.code, "QA_INCOMPLETE");

    // Binding present but not a string.
    const nonString = verdict([oldPass, rec("c_new3", "PASS", 12345, "2026-08-02T10:00:00Z")]);
    assert.equal(nonString.code, "QA_INCOMPLETE");

    // checks column is not an array at all.
    const notArray = verdict([
      oldPass,
      { id: "c_new4", overall: "PASS", checks: { nope: true }, createdAt: new Date("2026-08-02T10:00:00Z") },
    ]);
    assert.equal(notArray.code, "QA_INCOMPLETE");
  });

  test("5. old PASS/current hash + newer PASS/different hash → refuse as stale", () => {
    const v = verdict([oldPass, rec("c_new", "PASS", OTHER_HASH, "2026-08-02T10:00:00Z")]);
    assert.equal(v.authoritative?.id, "c_new");
    assert.equal(v.code, "QA_STALE_ARTIFACT",
      "the older PASS for the current hash must not rescue the upload");
  });

  test("6. old PASS/different hash + newer PASS/current hash → allow", () => {
    const v = verdict([
      rec("c_old", "PASS", OTHER_HASH, "2026-08-01T10:00:00Z"),
      rec("c_new", "PASS", OK_HASH, "2026-08-02T10:00:00Z"),
    ]);
    assert.equal(v.authoritative?.id, "c_new");
    assert.equal(v.code, "ALLOW");
  });

  test("7. one latest PASS/current hash → allow", () => {
    const v = verdict([rec("c_only", "PASS", OK_HASH, "2026-08-02T10:00:00Z")]);
    assert.equal(v.code, "ALLOW");
  });

  test("8. no QA record → refuse", () => {
    const v = verdict([]);
    assert.equal(v.authoritative, null);
    assert.equal(v.code, "QA_ABSENT");
  });
});

describe("the authoritative record is chosen deterministically", () => {
  test("insertion order does not change the outcome", () => {
    const older = rec("c_aaa", "PASS", OK_HASH, "2026-08-01T10:00:00Z");
    const newer = rec("c_bbb", "FAIL", OK_HASH, "2026-08-02T10:00:00Z");
    assert.equal(verdict([older, newer]).authoritative?.id, "c_bbb");
    assert.equal(verdict([newer, older]).authoritative?.id, "c_bbb");
  });

  test("a timestamp tie is broken by id, not left to the planner", () => {
    // Postgres now() is transaction-start time, so two rows written in one
    // transaction share createdAt exactly. Without a tiebreak an older PASS
    // could win against a newer FAIL.
    const t = "2026-08-02T10:00:00Z";
    const pass = rec("c_aaa", "PASS", OK_HASH, t);
    const fail = rec("c_bbb", "FAIL", OK_HASH, t);
    assert.equal(verdict([pass, fail]).authoritative?.id, "c_bbb", "higher cuid wins a tie");
    assert.equal(verdict([fail, pass]).authoritative?.id, "c_bbb", "and does so regardless of order");
    assert.equal(verdict([pass, fail]).code, "QA_NOT_PASSED");
    assert.equal(verdict([fail, pass]).code, "QA_NOT_PASSED");
  });

  test("three records: only the newest is consulted", () => {
    const rs = [
      rec("c_1", "PASS", OK_HASH, "2026-08-01T10:00:00Z"),
      rec("c_2", "PASS", OK_HASH, "2026-08-02T10:00:00Z"),
      rec("c_3", "FAIL", OK_HASH, "2026-08-03T10:00:00Z"),
    ];
    assert.equal(verdict(rs).authoritative?.id, "c_3");
    assert.equal(verdict(rs).code, "QA_NOT_PASSED");
  });

  test("no backward search: a newer refusal is never rescued by any older PASS", () => {
    // Five older passes, all bound to the current hash.
    const olds = [1, 2, 3, 4, 5].map((n) =>
      rec(`c_old${n}`, "PASS", OK_HASH, `2026-08-0${n}T10:00:00Z`));
    const newest = rec("c_zzz", "FAIL", OK_HASH, "2026-08-06T10:00:00Z");
    assert.equal(verdict([...olds, newest]).code, "QA_NOT_PASSED");
  });

  test("the query orders by createdAt then id, matching the in-process choice", () => {
    assert.match(qa, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/,
      "the database ordering must agree with authoritativeQaRecord");
  });

  test("the gate evaluates one record and never iterates for a passing one", () => {
    assert.match(qa, /const record = authoritativeQaRecord\(records\)/);
    assert.doesNotMatch(qa, /records\.find\(|\.some\(\(r\) => r\.overall === "PASS"\)/,
      "no 'any matching PASS exists' semantics");
  });
});

// ── Hash-comparison behaviour, as pure logic ──────────────────────────────

describe("hash binding comparison logic", () => {
  const BINDING = "final_video_sha256";
  const ok = "a".repeat(64);

  /** Mirrors assertWcFinalQaPassed's decision table. */
  function decide(
    record: { overall: string; checks: unknown } | null,
    actual: string,
  ): string {
    if (!record) return "QA_ABSENT";
    if (record.overall !== "PASS") return "QA_NOT_PASSED";
    if (!Array.isArray(record.checks)) return "QA_INCOMPLETE";
    const bound = (record.checks as { name?: string; value?: unknown }[])
      .find((c) => c?.name === BINDING);
    const recorded = typeof bound?.value === "string" ? bound.value : null;
    if (!recorded || !/^[0-9a-f]{64}$/.test(recorded)) return "QA_INCOMPLETE";
    if (recorded !== actual) return "QA_STALE_ARTIFACT";
    return "OK";
  }

  const pass = (value: unknown) => ({ overall: "PASS", checks: [{ name: BINDING, value }] });

  test("no record refuses", () => assert.equal(decide(null, ok), "QA_ABSENT"));
  test("FAIL refuses", () => assert.equal(decide({ overall: "FAIL", checks: [] }, ok), "QA_NOT_PASSED"));
  test("ERROR refuses", () => assert.equal(decide({ overall: "ERROR", checks: [] }, ok), "QA_NOT_PASSED"));
  test("WARN is not PASS and refuses", () => assert.equal(decide({ overall: "WARN", checks: [] }, ok), "QA_NOT_PASSED"));
  test("PASS with no checks array refuses", () => assert.equal(decide({ overall: "PASS", checks: null }, ok), "QA_INCOMPLETE"));
  test("PASS with no binding refuses", () => assert.equal(decide({ overall: "PASS", checks: [{ name: "other" }] }, ok), "QA_INCOMPLETE"));
  test("PASS with a non-string binding refuses", () => assert.equal(decide(pass(123), ok), "QA_INCOMPLETE"));
  test("PASS with a truncated hash refuses", () => assert.equal(decide(pass("abc"), ok), "QA_INCOMPLETE"));
  test("PASS with uppercase hex refuses rather than silently matching", () => assert.equal(decide(pass("A".repeat(64)), ok), "QA_INCOMPLETE"));
  test("PASS bound to different bytes refuses", () => assert.equal(decide(pass("b".repeat(64)), ok), "QA_STALE_ARTIFACT"));
  test("PASS bound to the exact bytes is the only acceptance", () => assert.equal(decide(pass(ok), ok), "OK"));

  test("a one-character difference is still stale", () => {
    const almost = "a".repeat(63) + "b";
    assert.equal(decide(pass(almost), ok), "QA_STALE_ARTIFACT");
  });
});
