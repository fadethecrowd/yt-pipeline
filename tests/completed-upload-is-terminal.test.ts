import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VideoStatus } from "@prisma/client";
import { RESUMABLE_STATUSES, QUARANTINE_STATUS } from "../packages/pipeline-core/src/lib/quarantine";
import { isRealYoutubeId } from "../packages/pipeline-core/src/lib/uploadSafety";
import {
  assertUploadable, createInMemoryIntentStore, UploadBlockedError, TERMINAL_UPLOADED_STATES,
} from "../packages/pipeline-core/src/lib/uploadIntent";

/**
 * A finished video must never be uploaded twice.
 *
 * The qualification benchmark (rrb0A_piLEM) is private, human-approved and
 * immutable. It was nearly re-uploaded: the run left its row at ASSEMBLY_DONE,
 * which is mid-pipeline and inside the resumable range, so a resumer would
 * have selected an already-uploaded asset and sent it again. "It already has a
 * youtubeId" does not stop the row being SELECTED — that guard only fires once
 * an upload is being attempted.
 *
 * Both defences are pinned here: a completed row is not selectable, and an
 * upload attempted against a completed row or a completed intent is refused.
 */

const CHANNEL_ID = "UCSbJfiA1aobp6G_rgwbHPMw";
const ok = {
  channelKey: "ai-doom-scroll" as const,
  videoId: "vid-1",
  existingYoutubeId: null as string | null,
  approvedFileSha256: "a".repeat(64),
  actualFileSha256: "a".repeat(64),
  approvedManifestSha256: "b".repeat(64),
  actualManifestSha256: "b".repeat(64),
  verifiedChannelId: CHANNEL_ID,
  privacyStatus: "private",
  publishAt: null as string | null,
};
const blocked = (e: unknown, code: string) =>
  e instanceof UploadBlockedError && e.code === code;

describe("a completed upload is not resumable work", () => {
  test("UPLOADED is not in the resumable range", () => {
    assert.ok(!RESUMABLE_STATUSES.includes(VideoStatus.UPLOADED),
      "a finished asset would be picked up and uploaded a second time");
  });

  test("PUBLISHED is not resumable either", () => {
    assert.ok(!RESUMABLE_STATUSES.includes(VideoStatus.PUBLISHED));
  });

  test("ASSEMBLY_DONE IS resumable — which is why finishing must move off it", () => {
    // Pins the hazard rather than the fix: if this stops being true, the
    // reasoning above changes and this file should be revisited.
    assert.ok(RESUMABLE_STATUSES.includes(VideoStatus.ASSEMBLY_DONE));
  });

  test("the quarantine status is terminal", () => {
    assert.ok(!RESUMABLE_STATUSES.includes(QUARANTINE_STATUS));
  });

  test("no resumable status is a finished one", () => {
    for (const s of RESUMABLE_STATUSES) {
      assert.ok(s !== VideoStatus.UPLOADED && s !== VideoStatus.PUBLISHED, `${s} is terminal`);
    }
  });
});

describe("real vs placeholder youtube ids", () => {
  test("a real id counts as uploaded", () => {
    assert.equal(isRealYoutubeId("rrb0A_piLEM"), true);
  });
  test("absent and dry-run ids do not", () => {
    for (const v of [null, undefined, "", "dryrun-abc"]) {
      assert.equal(isRealYoutubeId(v as never), false, String(v));
    }
  });
});

describe("assertUploadable refuses a second upload", () => {
  test("a row already carrying a youtube id is blocked", async () => {
    await assert.rejects(
      () => assertUploadable({ ...ok, existingYoutubeId: "rrb0A_piLEM" }, createInMemoryIntentStore()),
      (e: unknown) => blocked(e, "ALREADY_UPLOADED"),
      "the benchmark could have been uploaded twice",
    );
  });

  test("a completed intent blocks a second upload even if the row lost its id", async () => {
    const store = createInMemoryIntentStore();
    store.rows.push({
      id: "intent-1", videoId: "vid-1", state: "PERSISTED", youtubeId: "rrb0A_piLEM",
    } as never);
    await assert.rejects(
      () => assertUploadable(ok, store),
      (e: unknown) => blocked(e, "COMPLETED_INTENT_EXISTS"),
    );
  });

  test("both terminal intent states block", async () => {
    for (const state of TERMINAL_UPLOADED_STATES) {
      const store = createInMemoryIntentStore();
      store.rows.push({ id: `i-${state}`, videoId: "vid-1", state, youtubeId: "x" } as never);
      await assert.rejects(() => assertUploadable(ok, store), UploadBlockedError, state);
    }
  });

  test("a clean first upload is allowed", async () => {
    await assert.doesNotReject(() => assertUploadable(ok, createInMemoryIntentStore()));
  });
});

describe("the benchmark cannot be republished or retargeted by accident", () => {
  test("a changed artifact is refused", async () => {
    await assert.rejects(
      () => assertUploadable({ ...ok, actualFileSha256: "c".repeat(64) }, createInMemoryIntentStore()),
      (e: unknown) => blocked(e, "FILE_HASH_MISMATCH"),
    );
  });

  test("a changed scene manifest is refused", async () => {
    await assert.rejects(
      () => assertUploadable({ ...ok, actualManifestSha256: "d".repeat(64) }, createInMemoryIntentStore()),
      (e: unknown) => blocked(e, "MANIFEST_HASH_MISMATCH"),
    );
  });

  test("the wrong channel is refused", async () => {
    await assert.rejects(
      () => assertUploadable({ ...ok, verifiedChannelId: "UCwrongchannelxxxxxxxxx" }, createInMemoryIntentStore()),
      (e: unknown) => blocked(e, "CHANNEL_MISMATCH"),
    );
  });
});
