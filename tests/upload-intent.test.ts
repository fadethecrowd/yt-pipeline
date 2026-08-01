import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  guardedUpload,
  reconcileIntent,
  reconcileAll,
  createInMemoryIntentStore,
  correlationTag,
  correlationIdFromTags,
  metadataFingerprint,
  iso8601DurationToSeconds,
  classifyUploadDisposition,
  UploadBlockedError,
  CORRELATION_TAG_PREFIX,
} from "../packages/pipeline-core/src/lib/uploadIntent";
import type {
  IntentStore,
  RemoteVideo,
  UploadMetadata,
  YouTubePort,
  GuardedUploadInput,
  UploadIntentRecord,
} from "../packages/pipeline-core/src/lib/uploadIntent";

/**
 * Failure-injection tests for durable upload intent.
 *
 * These reproduce the uVQ-vcJHWNk failure exactly: YouTube accepts the upload
 * and the process dies before the id reaches the database. The old code left
 * no evidence, so `youtubeId IS NULL` read as "never uploaded" and a retry
 * would have uploaded a second copy to a real channel.
 *
 * Everything here is hermetic — an in-memory store and a mock YouTube port.
 * No database, no network, no credentials.
 */

const AI_DOOM = "UCSbJfiA1aobp6G_rgwbHPMw";
const FILE_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);

const METADATA: UploadMetadata = {
  title: "[PRIVATE QUALIFICATION] The Camera Above the Aisle Is Now Watching You",
  description: "PRIVATE PHASE 6 QUALIFICATION ASSET — not for publication.",
  tags: ["qualification", "internal"],
  categoryId: "28",
  privacyStatus: "private",
  publishAt: null,
};

/** A mock channel that records every insert. */
function mockYouTube(opts: { seed?: RemoteVideo[]; failInsert?: Error } = {}) {
  const remote: RemoteVideo[] = [...(opts.seed ?? [])];
  const inserts: { tags: string[]; title: string }[] = [];
  let n = 0;

  const port: YouTubePort = {
    async insert(req) {
      inserts.push({ tags: [...req.tags], title: req.title });
      if (opts.failInsert) throw opts.failInsert;
      const id = `yt-${++n}`;
      remote.push({
        id,
        title: req.title,
        tags: [...req.tags],
        privacyStatus: req.privacyStatus,
        publishAt: req.publishAt,
        channelId: AI_DOOM,
        durationS: 355,
        etag: `etag-${id}`,
        publishedAt: "2026-08-01T12:00:00Z",
      });
      return { id, etag: `etag-${id}`, publishedAt: "2026-08-01T12:00:00Z" };
    },
    async listChannelUploads() {
      return remote.map((v) => ({ ...v, tags: [...v.tags] }));
    },
    async getVideo(id) {
      return remote.find((v) => v.id === id) ?? null;
    },
  };

  return { port, inserts, remote };
}

/** Stands in for the video row the pipeline would update. */
function mockVideoRow() {
  const row: { youtubeId: string | null } = { youtubeId: null };
  return {
    row,
    persistYoutubeId: async (_i: UploadIntentRecord, youtubeId: string) => {
      row.youtubeId = youtubeId;
    },
  };
}

function input(over: Partial<GuardedUploadInput> = {}): GuardedUploadInput {
  return {
    channelKey: "ai-doom-scroll",
    assetKey: "ai1r",
    videoId: "vid-ai1r",
    testStage: "QUALIFICATION",
    format: "LONGFORM",
    filePath: "/tmp/final.mp4",
    fileSha256: FILE_HASH,
    manifestSha256: MANIFEST_HASH,
    metadata: METADATA,
    expectedDurationS: 355,
    existingYoutubeId: null,
    verifiedChannelId: AI_DOOM,
    actualFileSha256: FILE_HASH,
    actualManifestSha256: MANIFEST_HASH,
    ...over,
  };
}

async function expectBlocked(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof UploadBlockedError, `expected UploadBlockedError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ── The headline case ────────────────────────────────────────────────────

describe("crash after remote success", () => {
  test("reconciles and adopts the original id; insert happens exactly once", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    // Attempt 1: YouTube accepts, then the process dies before ANYTHING
    // durable is written about the id — the worst case, and the one that
    // produced uVQ-vcJHWNk.
    const boom = new Error("process killed after remote success");
    await assert.rejects(
      guardedUpload(input(), {
        port: yt.port,
        store,
        persistYoutubeId: video.persistYoutubeId,
        hooks: { afterRemoteCall: () => { throw boom; } },
      }),
      /process killed after remote success/,
    );

    assert.equal(yt.inserts.length, 1, "one insert so far");
    assert.equal(video.row.youtubeId, null, "video row never got the id");
    const [afterCrash] = await store.findByVideo("vid-ai1r");
    assert.equal(afterCrash!.state, "UPLOAD_STARTED", "intent records that a call was made");
    assert.equal(afterCrash!.youtubeId, null);

    // Restart: reconcile before anything else.
    const outcomes = await reconcileAll({
      port: yt.port,
      store,
      persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, "adopted");

    const adoptedId = (outcomes[0] as { youtubeId: string }).youtubeId;
    assert.equal(adoptedId, "yt-1", "adopted the id YouTube already had");
    assert.equal(yt.inserts.length, 1, "reconciliation issued NO second insert");
    assert.equal(video.row.youtubeId, "yt-1", "video row now carries the original id");

    const rows = await store.findByVideo("vid-ai1r");
    assert.equal(rows.length, 1, "exactly one intent row");
    assert.equal(rows[0]!.state, "PERSISTED");
    assert.equal(rows[0]!.adopted, true);
    assert.equal(rows[0]!.youtubeId, "yt-1");
    assert.equal(
      yt.remote.filter((v) => v.tags.some((t) => t.startsWith(CORRELATION_TAG_PREFIX))).length,
      1,
      "exactly one marked video exists remotely",
    );
  });

  test("a second upload attempt after reconciliation is impossible", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    await assert.rejects(
      guardedUpload(input(), {
        port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
        hooks: { afterRemoteCall: () => { throw new Error("crash"); } },
      }),
    );
    await reconcileAll({ port: yt.port, store, persistYoutubeId: video.persistYoutubeId });

    // Retry the whole upload: must short-circuit, not insert.
    const again = await guardedUpload(input({ existingYoutubeId: video.row.youtubeId }), {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(again.status, "already_uploaded");
    assert.equal(again.youtubeId, "yt-1");
    assert.equal(yt.inserts.length, 1, "still exactly one insert");
    assert.equal((await store.findByVideo("vid-ai1r")).length, 1);
  });

  test("crash after id is durable but before the video row is written", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    await assert.rejects(
      guardedUpload(input(), {
        port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
        hooks: { afterRemoteConfirmed: () => { throw new Error("db died"); } },
      }),
      /db died/,
    );
    const [mid] = await store.findByVideo("vid-ai1r");
    assert.equal(mid!.state, "REMOTE_CONFIRMED");
    assert.equal(mid!.youtubeId, "yt-1", "id was durable before the row update");

    const outcomes = await reconcileAll({
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(outcomes[0]!.outcome, "adopted");
    assert.equal(video.row.youtubeId, "yt-1");
    assert.equal(yt.inserts.length, 1);
  });
});

// ── Crash before the remote call ─────────────────────────────────────────

describe("crash before the remote call", () => {
  test("insert failure leaves no false success and no adoption", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube({ failInsert: new Error("network unreachable") });
    const video = mockVideoRow();

    await assert.rejects(
      guardedUpload(input(), { port: yt.port, store, persistYoutubeId: video.persistYoutubeId }),
      /network unreachable/,
    );

    const [intent] = await store.findByVideo("vid-ai1r");
    assert.equal(intent!.state, "RECONCILIATION_REQUIRED");
    assert.equal(intent!.youtubeId, null);
    assert.equal(video.row.youtubeId, null, "no false success");

    // Nothing was uploaded, so reconciliation finds nothing and must NOT
    // invent a success — and must not retry.
    const outcomes = await reconcileAll({
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(outcomes[0]!.outcome, "none");
    assert.equal(video.row.youtubeId, null);
    assert.equal(yt.inserts.length, 1, "the one failed attempt; no retry insert");
  });
});

// ── Reconciliation outcomes ──────────────────────────────────────────────

describe("reconciliation", () => {
  test("zero remote matches stops without retrying", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    const intent = await store.create({
      correlationId: "corr-orphan", channel: "ai-doom-scroll", channelId: AI_DOOM,
      testStage: "QUALIFICATION", format: "LONGFORM", assetKey: "ai1r",
      videoId: "vid-x", sourceTable: "video", fileSha256: FILE_HASH,
      manifestSha256: MANIFEST_HASH, metadataFingerprint: metadataFingerprint(METADATA),
      expectedTitle: METADATA.title, expectedPrivacy: "private", publishAtAbsent: true,
      expectedDurationS: 355, durationToleranceS: 2,
    });
    await store.update(intent.id, { state: "UPLOAD_STARTED" });

    const r = await reconcileIntent(
      (await store.findByVideo("vid-x"))[0]!,
      { port: yt.port, store, persistYoutubeId: video.persistYoutubeId },
    );
    assert.equal(r.outcome, "none");
    assert.equal(r.intent.state, "RECONCILIATION_REQUIRED");
    assert.match(r.intent.reconcileNote!, /refusing to re-upload/);
    assert.equal(yt.inserts.length, 0, "no insert issued");
  });

  test("more than one remote match quarantines and stops", async () => {
    const store = createInMemoryIntentStore();
    const marker = correlationTag("corr-dup");
    const dup = (id: string): RemoteVideo => ({
      id, title: METADATA.title, tags: ["internal", marker],
      privacyStatus: "private", publishAt: null, channelId: AI_DOOM,
      durationS: 355, etag: null, publishedAt: null,
    });
    const yt = mockYouTube({ seed: [dup("yt-dup-1"), dup("yt-dup-2")] });
    const video = mockVideoRow();

    const quarantined: string[] = [];
    const created = await store.create({
      correlationId: "corr-dup", channel: "ai-doom-scroll", channelId: AI_DOOM,
      testStage: "QUALIFICATION", format: "LONGFORM", assetKey: "ai1r",
      videoId: "vid-dup", sourceTable: "video", fileSha256: FILE_HASH,
      manifestSha256: MANIFEST_HASH, metadataFingerprint: metadataFingerprint(METADATA),
      expectedTitle: METADATA.title, expectedPrivacy: "private", publishAtAbsent: true,
      expectedDurationS: 355, durationToleranceS: 2,
    });
    await store.update(created.id, { state: "UPLOAD_STARTED" });

    const r = await reconcileIntent((await store.findByVideo("vid-dup"))[0]!, {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
      quarantine: async (_i, detail) => { quarantined.push(detail); },
    });

    assert.equal(r.outcome, "multiple");
    assert.deepEqual((r as { matches: string[] }).matches, ["yt-dup-1", "yt-dup-2"]);
    assert.equal(r.intent.state, "RECONCILIATION_REQUIRED");
    assert.equal(quarantined.length, 1, "escalated exactly once");
    assert.equal(video.row.youtubeId, null, "adopted nothing");
  });

  test("a marked remote video that contradicts the intent is not adopted", async () => {
    const store = createInMemoryIntentStore();
    const marker = correlationTag("corr-pub");
    const yt = mockYouTube({
      seed: [{
        id: "yt-public", title: METADATA.title, tags: [marker],
        privacyStatus: "public", publishAt: null, channelId: AI_DOOM,
        durationS: 355, etag: null, publishedAt: null,
      }],
    });
    const video = mockVideoRow();

    const created = await store.create({
      correlationId: "corr-pub", channel: "ai-doom-scroll", channelId: AI_DOOM,
      testStage: "QUALIFICATION", format: "LONGFORM", assetKey: "ai1r",
      videoId: "vid-pub", sourceTable: "video", fileSha256: FILE_HASH,
      manifestSha256: MANIFEST_HASH, metadataFingerprint: metadataFingerprint(METADATA),
      expectedTitle: METADATA.title, expectedPrivacy: "private", publishAtAbsent: true,
      expectedDurationS: 355, durationToleranceS: 2,
    });
    await store.update(created.id, { state: "UPLOAD_STARTED" });

    const r = await reconcileIntent((await store.findByVideo("vid-pub"))[0]!, {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(r.outcome, "none");
    assert.match(r.intent.reconcileNote!, /privacy public != private/);
    assert.equal(video.row.youtubeId, null);
  });
});

// ── Pre-upload guards ────────────────────────────────────────────────────

describe("guards block the upload", () => {
  const cases: { name: string; over: Partial<GuardedUploadInput>; code: string }[] = [
    {
      name: "file hash mismatch",
      over: { actualFileSha256: "c".repeat(64) },
      code: "FILE_HASH_MISMATCH",
    },
    {
      name: "scene-manifest hash mismatch",
      over: { actualManifestSha256: "d".repeat(64) },
      code: "MANIFEST_HASH_MISMATCH",
    },
    {
      name: "channel mismatch",
      over: { verifiedChannelId: "UC9iJDqlrKEs0uuMeIjb9DVA" },
      code: "CHANNEL_MISMATCH",
    },
    {
      name: "privacyStatus is not private",
      over: { metadata: { ...METADATA, privacyStatus: "public" } },
      code: "NOT_PRIVATE",
    },
    {
      name: "publishAt present",
      over: { metadata: { ...METADATA, publishAt: "2026-09-01T19:00:00Z" } },
      code: "PUBLISH_AT_SET",
    },
    {
      name: "video row already has a youtubeId",
      over: { existingYoutubeId: "already-there" },
      code: "ALREADY_UPLOADED",
    },
  ];

  for (const c of cases) {
    test(`${c.name} → ${c.code}, no insert`, async () => {
      const store = createInMemoryIntentStore();
      const yt = mockYouTube();
      const video = mockVideoRow();
      await expectBlocked(
        () => guardedUpload(input(c.over), {
          port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
        }),
        c.code,
      );
      assert.equal(yt.inserts.length, 0, "nothing was sent");
      assert.equal(video.row.youtubeId, null);
    });
  }

  test("an existing completed intent blocks a further upload", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    const first = await guardedUpload(input(), {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(first.status, "uploaded");

    // Same asset, a *different* approved artifact — the completed intent for
    // this asset must still block it.
    const second = await guardedUpload(
      input({ fileSha256: "e".repeat(64), actualFileSha256: "e".repeat(64) }),
      { port: yt.port, store, persistYoutubeId: video.persistYoutubeId },
    );
    assert.equal(second.status, "already_uploaded");
    assert.equal(yt.inserts.length, 1, "no second insert");
  });

  test("a dryrun placeholder id is not treated as a real upload", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();
    const r = await guardedUpload(input({ existingYoutubeId: "dryrun-vid-ai1r" }), {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(r.status, "uploaded");
    assert.equal(yt.inserts.length, 1);
  });

  test("a fresh upload over an unresolved intent adopts the orphan instead of re-uploading", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    await assert.rejects(
      guardedUpload(input(), {
        port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
        hooks: { afterRemoteCall: () => { throw new Error("crash"); } },
      }),
    );

    // The caller does not reconcile first — it just retries the upload. The
    // unresolved intent must still be resolved against the remote channel
    // before any insert, so the orphan is adopted rather than duplicated.
    const retry = await guardedUpload(input(), {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });
    assert.equal(retry.status, "adopted");
    assert.equal(retry.youtubeId, "yt-1");
    assert.equal(yt.inserts.length, 1, "never issued a second insert");
    assert.equal(video.row.youtubeId, "yt-1");
    assert.equal((await store.findByVideo("vid-ai1r")).length, 1);
  });

  test("an unreconcilable intent blocks any further upload", async () => {
    const store = createInMemoryIntentStore();
    // Insert succeeds remotely but the mock strips tags, so the orphan cannot
    // be identified — the genuinely ambiguous case.
    const yt = mockYouTube();
    const stripped: YouTubePort = {
      ...yt.port,
      listChannelUploads: async () =>
        (await yt.port.listChannelUploads()).map((v) => ({ ...v, tags: [] })),
    };
    const video = mockVideoRow();

    await assert.rejects(
      guardedUpload(input(), {
        port: stripped, store, persistYoutubeId: video.persistYoutubeId,
        hooks: { afterRemoteCall: () => { throw new Error("crash"); } },
      }),
    );
    await expectBlocked(
      () => guardedUpload(input(), {
        port: stripped, store, persistYoutubeId: video.persistYoutubeId,
      }),
      "RECONCILIATION_REQUIRED",
    );
    assert.equal(yt.inserts.length, 1, "never issued a second insert");
    assert.equal(video.row.youtubeId, null, "no false success");
  });
});

// ── Historical reconciliation ────────────────────────────────────────────

describe("historical remote adoption", () => {
  const historicalBase = {
    channel: "ai-doom-scroll", channelId: AI_DOOM, testStage: "QUALIFICATION" as const,
    format: "LONGFORM", assetKey: "ai1", videoId: "vid-hbm", sourceTable: "video",
    fileSha256: null, manifestSha256: null,
    metadataFingerprint: metadataFingerprint(METADATA), expectedTitle: METADATA.title,
    expectedPrivacy: "private", publishAtAbsent: true, expectedDurationS: 436,
    durationToleranceS: 2, correlationId: "local-historical-1",
    provenance: "HISTORICAL_RECONCILIATION", remoteMarkerPresent: false,
    fileHashVerified: false, manifestHashVerified: false,
    inferredFileSha256: "811e6134".padEnd(64, "0"), inferredManifestSha256: null,
    evidenceNote: "runtime match only; predates marker mechanism",
  };

  test("blocks any further upload of the same asset", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    const created = await store.create(historicalBase);
    await store.update(created.id, {
      state: "RECONCILED_HISTORICAL_UPLOAD", youtubeId: "uVQ-vcJHWNk", adopted: true,
    });

    const r = await guardedUpload(
      input({ videoId: "vid-hbm", assetKey: "ai1" }),
      { port: yt.port, store, persistYoutubeId: video.persistYoutubeId },
    );
    assert.equal(r.status, "already_uploaded");
    assert.equal(r.youtubeId, "uVQ-vcJHWNk");
    assert.equal(yt.inserts.length, 0, "no insert issued");
  });

  test("is terminal — not treated as unresolved work", async () => {
    const store = createInMemoryIntentStore();
    const created = await store.create(historicalBase);
    await store.update(created.id, {
      state: "RECONCILED_HISTORICAL_UPLOAD", youtubeId: "uVQ-vcJHWNk", adopted: true,
    });
    assert.equal((await store.listUnresolved()).length, 0);
  });

  test("classifies distinctly from a marker-backed upload", async () => {
    const store = createInMemoryIntentStore();
    const created = await store.create(historicalBase);
    const hist = await store.update(created.id, {
      state: "RECONCILED_HISTORICAL_UPLOAD", youtubeId: "uVQ-vcJHWNk", adopted: true,
    });
    const d = classifyUploadDisposition({
      localYoutubeId: "uVQ-vcJHWNk", intents: [hist], remoteMatches: [],
    });
    assert.equal(d.disposition, "VERIFIED_HISTORICAL_REMOTE_ADOPTION");
    assert.equal(d.blocking, false, "truthfully represented, so no longer blocking");
    assert.match(d.detail, /remote marker present=false/);
    assert.match(d.detail, /file hash verified=false/);
    assert.match(d.detail, /manifest hash verified=false/);
  });

  test("a second historical adoption for the same asset is rejected", async () => {
    const store = createInMemoryIntentStore();
    const a = await store.create(historicalBase);
    await store.update(a.id, { state: "RECONCILED_HISTORICAL_UPLOAD", youtubeId: "uVQ-vcJHWNk" });
    const b = await store.create({ ...historicalBase, correlationId: "local-historical-2" });
    await assert.rejects(
      () => store.update(b.id, { state: "RECONCILED_HISTORICAL_UPLOAD", youtubeId: "other" }),
      /one completed intent per videoId/,
    );
  });
});

// ── Correlation marker and metadata ──────────────────────────────────────

describe("correlation marker", () => {
  test("is written into the uploaded tags without touching the title", async () => {
    const store = createInMemoryIntentStore();
    const yt = mockYouTube();
    const video = mockVideoRow();

    await guardedUpload(input(), {
      port: yt.port, store, persistYoutubeId: video.persistYoutubeId,
    });

    const sent = yt.inserts[0]!;
    assert.equal(sent.title, METADATA.title, "viewer-facing title unchanged");
    assert.ok(sent.tags.includes("qualification"));
    assert.ok(sent.tags.includes("internal"));
    const marker = sent.tags.find((t) => t.startsWith(CORRELATION_TAG_PREFIX));
    assert.ok(marker, "correlation tag present");
    const [row] = await store.findByVideo("vid-ai1r");
    assert.equal(marker, correlationTag(row!.correlationId));
  });

  test("round-trips through tag extraction", () => {
    assert.equal(correlationIdFromTags(["internal", "qid-abc"]), "abc");
    assert.equal(correlationIdFromTags(["internal"]), null);
    assert.equal(correlationIdFromTags(null), null);
  });

  test("metadata fingerprint ignores tag order and the marker itself", () => {
    const a = metadataFingerprint(METADATA);
    const b = metadataFingerprint({ ...METADATA, tags: ["internal", "qualification"] });
    const c = metadataFingerprint({ ...METADATA, tags: [...METADATA.tags, "qid-xyz"] });
    assert.equal(a, b);
    assert.equal(a, c);
    assert.notEqual(a, metadataFingerprint({ ...METADATA, title: "different" }));
  });

  test("ISO-8601 durations parse", () => {
    assert.equal(iso8601DurationToSeconds("PT7M16S"), 436);
    assert.equal(iso8601DurationToSeconds("PT5M55S"), 355);
    assert.equal(iso8601DurationToSeconds("PT1H2M3S"), 3723);
    assert.equal(iso8601DurationToSeconds(null), null);
  });
});

// ── Store invariants mirror the database constraints ─────────────────────

describe("store invariants", () => {
  test("two active intents for one asset are rejected", async () => {
    const store: IntentStore = createInMemoryIntentStore();
    const base = {
      channel: "ai-doom-scroll", channelId: AI_DOOM, testStage: "QUALIFICATION" as const,
      format: "LONGFORM", assetKey: "ai1r", videoId: "vid-dupe", sourceTable: "video",
      fileSha256: FILE_HASH, manifestSha256: MANIFEST_HASH,
      metadataFingerprint: metadataFingerprint(METADATA), expectedTitle: METADATA.title,
      expectedPrivacy: "private", publishAtAbsent: true, expectedDurationS: 355,
      durationToleranceS: 2,
    };
    await store.create({ ...base, correlationId: "c1" });
    await assert.rejects(
      () => store.create({ ...base, correlationId: "c2" }),
      /one active intent per videoId/,
    );
  });

  test("a reused correlation id is rejected", async () => {
    const store: IntentStore = createInMemoryIntentStore();
    const base = {
      channel: "ai-doom-scroll", channelId: AI_DOOM, testStage: "QUALIFICATION" as const,
      format: "LONGFORM", assetKey: "ai1r", sourceTable: "video",
      fileSha256: FILE_HASH, manifestSha256: MANIFEST_HASH,
      metadataFingerprint: metadataFingerprint(METADATA), expectedTitle: METADATA.title,
      expectedPrivacy: "private", publishAtAbsent: true, expectedDurationS: 355,
      durationToleranceS: 2, correlationId: "same",
    };
    await store.create({ ...base, videoId: "vid-a" });
    await assert.rejects(
      () => store.create({ ...base, videoId: "vid-b" }),
      /correlationId reused/,
    );
  });
});
