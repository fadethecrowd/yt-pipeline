import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { TestStage, UploadIntentState } from "@prisma/client";
import { prisma } from "./db";
import { buildYouTubeClient, CHANNELS } from "../youtubeAuth";
import type { ChannelKey } from "../youtubeAuth";
import { tripBreaker } from "./circuitBreaker";

/**
 * Durable upload intent and remote reconciliation.
 *
 * The failure this exists for is not hypothetical. Qualification asset ai1 was
 * accepted by YouTube as uVQ-vcJHWNk; the process died between `videos.insert`
 * returning and the id being written to the video row. Every local check —
 * `youtubeId IS NULL`, "no duplicate upload record" — then reported the asset
 * as never uploaded, so a retry would have produced a second copy on a real
 * channel.
 *
 * The fix has two halves:
 *
 *   1. A durable row written BEFORE the remote call, so a crash at any point
 *      leaves evidence that distinguishes "YouTube never saw this" from
 *      "YouTube may already have this".
 *   2. A correlation marker echoed into the uploaded video's tags, so the
 *      remote object identifies itself and can be found again with no local
 *      record of its id.
 *
 * Reconciliation never guesses. Exactly one marked remote match is adopted;
 * zero is ambiguous and stops; more than one quarantines.
 */

// ── Correlation marker ───────────────────────────────────────────────────

/**
 * Tag prefix carrying the correlation id.
 *
 * Tags are used rather than the title or description because the marker must
 * not change what a reviewer sees. Tags are not rendered on the watch page,
 * survive processing, and come back verbatim from `videos.list`.
 */
export const CORRELATION_TAG_PREFIX = "qid-";

export function correlationTag(correlationId: string): string {
  return `${CORRELATION_TAG_PREFIX}${correlationId}`;
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Extract a correlation id from a remote video's tags, if present. */
export function correlationIdFromTags(tags: readonly string[] | null | undefined): string | null {
  for (const t of tags ?? []) {
    if (t.startsWith(CORRELATION_TAG_PREFIX)) return t.slice(CORRELATION_TAG_PREFIX.length);
  }
  return null;
}

// ── Metadata fingerprint ─────────────────────────────────────────────────

export interface UploadMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: string;
  publishAt: string | null;
}

/**
 * Stable hash of the metadata an upload was approved with. Tags are sorted so
 * ordering cannot change the fingerprint; the correlation tag is excluded so
 * the fingerprint describes the *approved* metadata rather than the marker.
 */
export function metadataFingerprint(m: UploadMetadata): string {
  const canonical = JSON.stringify({
    title: m.title,
    description: m.description,
    tags: [...m.tags].filter((t) => !t.startsWith(CORRELATION_TAG_PREFIX)).sort(),
    categoryId: m.categoryId,
    privacyStatus: m.privacyStatus,
    publishAt: m.publishAt,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ── Records and ports ────────────────────────────────────────────────────

export interface UploadIntentRecord {
  id: string;
  correlationId: string;
  channel: string;
  channelId: string;
  testStage: TestStage;
  format: string;
  assetKey: string;
  videoId: string;
  sourceTable: string;
  fileSha256: string | null;
  manifestSha256: string | null;
  metadataFingerprint: string;
  provenance: string;
  remoteMarkerPresent: boolean;
  fileHashVerified: boolean;
  manifestHashVerified: boolean;
  inferredFileSha256: string | null;
  inferredManifestSha256: string | null;
  evidenceNote: string | null;
  expectedTitle: string;
  expectedPrivacy: string;
  publishAtAbsent: boolean;
  expectedDurationS: number | null;
  durationToleranceS: number;
  state: UploadIntentState;
  youtubeId: string | null;
  remoteEtag: string | null;
  remotePublishedAt: Date | null;
  adopted: boolean;
  attempts: number;
  lastError: string | null;
  reconcileNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewUploadIntent = Omit<
  UploadIntentRecord,
  | "id" | "state" | "youtubeId" | "remoteEtag" | "remotePublishedAt" | "adopted"
  | "attempts" | "lastError" | "reconcileNote" | "resolvedAt" | "createdAt" | "updatedAt"
  | "provenance" | "remoteMarkerPresent" | "fileHashVerified" | "manifestHashVerified"
  | "inferredFileSha256" | "inferredManifestSha256" | "evidenceNote"
> & Partial<
  Pick<
    UploadIntentRecord,
    | "provenance" | "remoteMarkerPresent" | "fileHashVerified" | "manifestHashVerified"
    | "inferredFileSha256" | "inferredManifestSha256" | "evidenceNote"
  >
>;

/** Persistence boundary — swapped for an in-memory store in tests. */
export interface IntentStore {
  findByArtifact(
    videoId: string, fileSha256: string, manifestSha256: string,
  ): Promise<UploadIntentRecord | null>;
  findByVideo(videoId: string): Promise<UploadIntentRecord[]>;
  listUnresolved(channel?: string): Promise<UploadIntentRecord[]>;
  create(data: NewUploadIntent): Promise<UploadIntentRecord>;
  update(id: string, patch: Partial<UploadIntentRecord>): Promise<UploadIntentRecord>;
}

export interface RemoteVideo {
  id: string;
  title: string | null;
  tags: string[];
  privacyStatus: string | null;
  publishAt: string | null;
  channelId: string | null;
  durationS: number | null;
  etag?: string | null;
  publishedAt?: string | null;
}

export interface InsertRequest {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: string;
  publishAt: string | null;
  filePath: string;
}

/** YouTube boundary — swapped for a mock in tests. */
export interface YouTubePort {
  insert(req: InsertRequest): Promise<{ id: string; etag?: string | null; publishedAt?: string | null }>;
  /** Every video on the authenticated channel, used for marker reconciliation. */
  listChannelUploads(): Promise<RemoteVideo[]>;
  getVideo(id: string): Promise<RemoteVideo | null>;
}

/**
 * Terminal states meaning "this asset is already on YouTube". A historical
 * adoption blocks a further upload exactly like a normal completed one.
 */
export const TERMINAL_UPLOADED_STATES: UploadIntentState[] = [
  "PERSISTED", "RECONCILED_HISTORICAL_UPLOAD",
];

/** States in which an upload path is open and no new one may start. */
const ACTIVE_STATES: UploadIntentState[] = ["PREPARED", "UPLOAD_STARTED"];
/** States whose remote outcome is not yet known to be settled. */
const UNRESOLVED_STATES: UploadIntentState[] = [
  "PREPARED", "UPLOAD_STARTED", "REMOTE_CONFIRMED", "RECONCILIATION_REQUIRED",
];

export function isUnresolved(s: UploadIntentState): boolean {
  return UNRESOLVED_STATES.includes(s);
}

// ── Prisma-backed store ──────────────────────────────────────────────────

export const prismaIntentStore: IntentStore = {
  findByArtifact: (videoId, fileSha256, manifestSha256) =>
    prisma.uploadIntent.findUnique({
      where: { videoId_fileSha256_manifestSha256: { videoId, fileSha256, manifestSha256 } },
    }) as Promise<UploadIntentRecord | null>,
  findByVideo: (videoId) =>
    prisma.uploadIntent.findMany({ where: { videoId } }) as Promise<UploadIntentRecord[]>,
  listUnresolved: (channel) =>
    prisma.uploadIntent.findMany({
      where: { state: { in: UNRESOLVED_STATES }, ...(channel ? { channel } : {}) },
      orderBy: { createdAt: "asc" },
    }) as Promise<UploadIntentRecord[]>,
  create: (data) => prisma.uploadIntent.create({ data }) as Promise<UploadIntentRecord>,
  update: (id, patch) =>
    prisma.uploadIntent.update({ where: { id }, data: patch }) as Promise<UploadIntentRecord>,
};

// ── Guards ───────────────────────────────────────────────────────────────

export class UploadBlockedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UploadBlockedError";
  }
}

export interface UploadGuardInput {
  channelKey: ChannelKey;
  videoId: string;
  /** The id already on the video row, if any. */
  existingYoutubeId: string | null | undefined;
  approvedFileSha256: string;
  actualFileSha256: string;
  approvedManifestSha256: string;
  actualManifestSha256: string;
  verifiedChannelId: string;
  privacyStatus: string;
  publishAt: string | null;
}

function isRealId(id: string | null | undefined): boolean {
  return Boolean(id) && !id!.startsWith("dryrun-");
}

/**
 * Every precondition that must hold before a byte is sent. Fails closed on the
 * first violation; the caller never gets a partial pass.
 */
export async function assertUploadable(
  input: UploadGuardInput,
  store: IntentStore = prismaIntentStore,
): Promise<void> {
  const spec = CHANNELS[input.channelKey];

  if (input.verifiedChannelId !== spec.id) {
    throw new UploadBlockedError(
      "CHANNEL_MISMATCH",
      `authenticated channel ${input.verifiedChannelId} is not ${spec.title} (${spec.id})`,
    );
  }
  if (input.privacyStatus !== "private") {
    throw new UploadBlockedError(
      "NOT_PRIVATE", `privacyStatus must be "private", got "${input.privacyStatus}"`,
    );
  }
  if (input.publishAt !== null) {
    throw new UploadBlockedError(
      "PUBLISH_AT_SET", `publishAt must be absent, got "${input.publishAt}"`,
    );
  }
  if (input.actualFileSha256 !== input.approvedFileSha256) {
    throw new UploadBlockedError(
      "FILE_HASH_MISMATCH",
      `artifact changed since approval — approved ${input.approvedFileSha256.slice(0, 16)}… ` +
        `actual ${input.actualFileSha256.slice(0, 16)}…`,
    );
  }
  if (input.actualManifestSha256 !== input.approvedManifestSha256) {
    throw new UploadBlockedError(
      "MANIFEST_HASH_MISMATCH",
      `scene manifest changed since approval — approved ${input.approvedManifestSha256.slice(0, 16)}… ` +
        `actual ${input.actualManifestSha256.slice(0, 16)}…`,
    );
  }
  if (isRealId(input.existingYoutubeId)) {
    throw new UploadBlockedError(
      "ALREADY_UPLOADED", `video row already carries youtubeId ${input.existingYoutubeId}`,
    );
  }

  const intents = await store.findByVideo(input.videoId);
  const persisted = intents.find((i) => TERMINAL_UPLOADED_STATES.includes(i.state));
  if (persisted) {
    throw new UploadBlockedError(
      "COMPLETED_INTENT_EXISTS",
      `upload intent ${persisted.id} already completed as ${persisted.youtubeId} ` +
        `(state=${persisted.state})`,
    );
  }
  const blocked = intents.find((i) => i.state === "RECONCILIATION_REQUIRED");
  if (blocked) {
    throw new UploadBlockedError(
      "RECONCILIATION_REQUIRED",
      `upload intent ${blocked.id} needs manual reconciliation: ${blocked.reconcileNote ?? "unknown remote state"}`,
    );
  }
  const inFlight = intents.find(
    (i) => ACTIVE_STATES.includes(i.state) || i.state === "REMOTE_CONFIRMED",
  );
  if (inFlight) {
    throw new UploadBlockedError(
      "UNRESOLVED_INTENT",
      `upload intent ${inFlight.id} is unresolved (state=${inFlight.state}); ` +
        `reconcile it before attempting another upload`,
    );
  }
}

// ── Reconciliation ───────────────────────────────────────────────────────

/** Default escalation: trip the channel circuit breaker. */
async function defaultQuarantine(intent: UploadIntentRecord, detail: string): Promise<void> {
  await tripBreaker(intent.channel as ChannelKey, "DUPLICATE_UPLOAD", detail, [intent.videoId]);
}

export type ReconcileOutcome =
  | { outcome: "adopted"; youtubeId: string; intent: UploadIntentRecord }
  | { outcome: "already_persisted"; youtubeId: string; intent: UploadIntentRecord }
  | { outcome: "none"; intent: UploadIntentRecord }
  | { outcome: "multiple"; matches: string[]; intent: UploadIntentRecord };

export interface ReconcileDeps {
  port: YouTubePort;
  store?: IntentStore;
  /** Writes the adopted id onto the owning video row. */
  persistYoutubeId: (intent: UploadIntentRecord, youtubeId: string) => Promise<void>;
  /**
   * Escalation for an unrecoverable duplicate. Defaults to tripping the
   * circuit breaker; injectable so tests never write to a live database.
   */
  quarantine?: (intent: UploadIntentRecord, detail: string) => Promise<void>;
}

/**
 * Resolve one unresolved intent against the remote channel.
 *
 * Never issues `videos.insert`. A null local youtubeId is not evidence of
 * anything, so the remote channel is the authority.
 */
export async function reconcileIntent(
  intent: UploadIntentRecord,
  deps: ReconcileDeps,
): Promise<ReconcileOutcome> {
  const store = deps.store ?? prismaIntentStore;

  if (TERMINAL_UPLOADED_STATES.includes(intent.state) && intent.youtubeId) {
    return { outcome: "already_persisted", youtubeId: intent.youtubeId, intent };
  }

  const marker = correlationTag(intent.correlationId);
  const remote = await deps.port.listChannelUploads();
  const matches = remote.filter((v) => v.tags.includes(marker));

  if (matches.length > 1) {
    const ids = matches.map((m) => m.id);
    const updated = await store.update(intent.id, {
      state: "RECONCILIATION_REQUIRED",
      reconcileNote:
        `${ids.length} remote videos carry correlation ${intent.correlationId}: ${ids.join(", ")}`,
    });
    const escalate = deps.quarantine ?? defaultQuarantine;
    await escalate(
      intent,
      `correlation ${intent.correlationId} matched ${ids.length} remote videos: ${ids.join(", ")}`,
    );
    return { outcome: "multiple", matches: ids, intent: updated };
  }

  if (matches.length === 0) {
    // Ambiguous by construction: either the insert never reached YouTube, or
    // it did and the marker is missing. Retrying could duplicate, so stop.
    const updated = await store.update(intent.id, {
      state: "RECONCILIATION_REQUIRED",
      reconcileNote:
        `no remote video carries correlation ${intent.correlationId}. The remote outcome of ` +
        `state=${intent.state} is unknown; refusing to re-upload. Resolve manually.`,
    });
    return { outcome: "none", intent: updated };
  }

  const match = matches[0]!;

  // The marker alone is not enough — the remote object must also match the
  // immutable expectations recorded before the call.
  const problems: string[] = [];
  if (match.channelId && match.channelId !== intent.channelId) {
    problems.push(`channel ${match.channelId} != ${intent.channelId}`);
  }
  if (match.privacyStatus && match.privacyStatus !== intent.expectedPrivacy) {
    problems.push(`privacy ${match.privacyStatus} != ${intent.expectedPrivacy}`);
  }
  if (intent.publishAtAbsent && match.publishAt) {
    problems.push(`publishAt ${match.publishAt} present but must be absent`);
  }
  if (
    intent.expectedDurationS != null && match.durationS != null &&
    Math.abs(match.durationS - intent.expectedDurationS) > intent.durationToleranceS
  ) {
    problems.push(`duration ${match.durationS}s != ${intent.expectedDurationS}s`);
  }
  if (problems.length > 0) {
    const updated = await store.update(intent.id, {
      state: "RECONCILIATION_REQUIRED",
      reconcileNote: `remote ${match.id} carries the marker but does not match: ${problems.join("; ")}`,
    });
    return { outcome: "none", intent: updated };
  }

  // Adopt: the id becomes durable before the video row is touched.
  let updated = await store.update(intent.id, {
    state: "REMOTE_CONFIRMED",
    youtubeId: match.id,
    remoteEtag: match.etag ?? null,
    remotePublishedAt: match.publishedAt ? new Date(match.publishedAt) : null,
    adopted: true,
  });
  await deps.persistYoutubeId(updated, match.id);
  updated = await store.update(intent.id, { state: "PERSISTED", resolvedAt: new Date() });

  return { outcome: "adopted", youtubeId: match.id, intent: updated };
}

/** Reconcile every unresolved intent, newest last. */
export async function reconcileAll(
  deps: ReconcileDeps & { channel?: string },
): Promise<ReconcileOutcome[]> {
  const store = deps.store ?? prismaIntentStore;
  const open = await store.listUnresolved(deps.channel);
  const out: ReconcileOutcome[] = [];
  for (const intent of open) out.push(await reconcileIntent(intent, deps));
  return out;
}

// ── Guarded upload ───────────────────────────────────────────────────────

export interface GuardedUploadInput {
  channelKey: ChannelKey;
  assetKey: string;
  videoId: string;
  sourceTable?: string;
  testStage: TestStage;
  format: string;
  filePath: string;
  fileSha256: string;
  manifestSha256: string;
  metadata: UploadMetadata;
  expectedDurationS?: number | null;
  existingYoutubeId?: string | null;
  verifiedChannelId: string;
  actualFileSha256: string;
  actualManifestSha256: string;
}

export interface GuardedUploadDeps extends ReconcileDeps {
  /** Test seams: throw to simulate a crash at an exact point. */
  hooks?: {
    /** After videos.insert returns, before the id is made durable. */
    afterRemoteCall?: (youtubeId: string) => void | Promise<void>;
    /** After the id is durable, before the video row is updated. */
    afterRemoteConfirmed?: (youtubeId: string) => void | Promise<void>;
  };
}

export type GuardedUploadResult =
  | { status: "uploaded"; youtubeId: string; intent: UploadIntentRecord }
  | { status: "adopted"; youtubeId: string; intent: UploadIntentRecord }
  | { status: "already_uploaded"; youtubeId: string; intent: UploadIntentRecord };

/**
 * Upload exactly once, or explain why not.
 *
 * Ordering is the whole point:
 *   PREPARED (durable) → UPLOAD_STARTED (durable) → videos.insert →
 *   REMOTE_CONFIRMED + id (durable) → video row → PERSISTED
 *
 * A crash between any two steps leaves a row whose state says whether YouTube
 * might already hold the asset. No path re-issues `videos.insert` because the
 * local id is null.
 */
export async function guardedUpload(
  input: GuardedUploadInput,
  deps: GuardedUploadDeps,
): Promise<GuardedUploadResult> {
  const store = deps.store ?? prismaIntentStore;
  const spec = CHANNELS[input.channelKey];

  // An unresolved intent for this asset is reconciled before anything else —
  // it may already have succeeded remotely.
  const existing = await store.findByVideo(input.videoId);
  const openIntent = existing.find((i) => isUnresolved(i.state));
  if (openIntent) {
    const r = await reconcileIntent(openIntent, deps);
    if (r.outcome === "adopted") {
      return { status: "adopted", youtubeId: r.youtubeId, intent: r.intent };
    }
    if (r.outcome === "already_persisted") {
      return { status: "already_uploaded", youtubeId: r.youtubeId, intent: r.intent };
    }
    throw new UploadBlockedError(
      "RECONCILIATION_REQUIRED",
      r.outcome === "multiple"
        ? `correlation ${openIntent.correlationId} matched ${r.matches.length} remote videos — quarantined`
        : `unresolved intent ${openIntent.id} could not be reconciled; refusing to upload again`,
    );
  }
  const persisted = existing.find((i) => TERMINAL_UPLOADED_STATES.includes(i.state));
  if (persisted?.youtubeId) {
    return { status: "already_uploaded", youtubeId: persisted.youtubeId, intent: persisted };
  }

  await assertUploadable(
    {
      channelKey: input.channelKey,
      videoId: input.videoId,
      existingYoutubeId: input.existingYoutubeId,
      approvedFileSha256: input.fileSha256,
      actualFileSha256: input.actualFileSha256,
      approvedManifestSha256: input.manifestSha256,
      actualManifestSha256: input.actualManifestSha256,
      verifiedChannelId: input.verifiedChannelId,
      privacyStatus: input.metadata.privacyStatus,
      publishAt: input.metadata.publishAt,
    },
    store,
  );

  // A remote video already carrying a marker for this artifact means an
  // earlier attempt succeeded and left no local trace.
  const priorRemote = await deps.port.listChannelUploads();
  const known = new Set(existing.map((i) => correlationTag(i.correlationId)));
  const orphan = priorRemote.find((v) => v.tags.some((t) => known.has(t)));
  if (orphan) {
    throw new UploadBlockedError(
      "REMOTE_ORPHAN",
      `remote video ${orphan.id} already carries a correlation marker for this asset`,
    );
  }

  const correlationId = newCorrelationId();
  const intent = await store.create({
    correlationId,
    channel: input.channelKey,
    channelId: spec.id,
    testStage: input.testStage,
    format: input.format,
    assetKey: input.assetKey,
    videoId: input.videoId,
    sourceTable: input.sourceTable ?? "video",
    fileSha256: input.fileSha256,
    manifestSha256: input.manifestSha256,
    metadataFingerprint: metadataFingerprint(input.metadata),
    expectedTitle: input.metadata.title,
    expectedPrivacy: input.metadata.privacyStatus,
    publishAtAbsent: input.metadata.publishAt === null,
    expectedDurationS: input.expectedDurationS ?? null,
    durationToleranceS: 2,
  });

  const tags = [...input.metadata.tags, correlationTag(correlationId)];

  let current = await store.update(intent.id, {
    state: "UPLOAD_STARTED",
    attempts: intent.attempts + 1,
  });

  let remote: { id: string; etag?: string | null; publishedAt?: string | null };
  try {
    remote = await deps.port.insert({
      title: input.metadata.title,
      description: input.metadata.description,
      tags,
      categoryId: input.metadata.categoryId,
      privacyStatus: input.metadata.privacyStatus,
      publishAt: input.metadata.publishAt,
      filePath: input.filePath,
    });
  } catch (err) {
    // The call itself failed. It is still not safe to assume YouTube saw
    // nothing, so the intent stays unresolved for reconciliation rather than
    // being marked cleanly retryable.
    const message = err instanceof Error ? err.message : String(err);
    await store.update(intent.id, {
      state: "RECONCILIATION_REQUIRED",
      lastError: message,
      reconcileNote: `videos.insert threw: ${message}. Remote outcome unknown.`,
    });
    throw err;
  }

  // Crash seam: remote succeeded, nothing durable yet. Reconciliation must
  // recover this from the marker alone.
  if (deps.hooks?.afterRemoteCall) await deps.hooks.afterRemoteCall(remote.id);

  current = await store.update(intent.id, {
    state: "REMOTE_CONFIRMED",
    youtubeId: remote.id,
    remoteEtag: remote.etag ?? null,
    remotePublishedAt: remote.publishedAt ? new Date(remote.publishedAt) : null,
  });

  // Crash seam: id is durable, video row is not yet updated.
  if (deps.hooks?.afterRemoteConfirmed) await deps.hooks.afterRemoteConfirmed(remote.id);

  await deps.persistYoutubeId(current, remote.id);
  current = await store.update(intent.id, { state: "PERSISTED", resolvedAt: new Date() });

  return { status: "uploaded", youtubeId: remote.id, intent: current };
}

// ── In-memory store (tests) ──────────────────────────────────────────────

/**
 * Deterministic store for failure-injection tests. Enforces the same
 * uniqueness the database enforces, so a test cannot pass on a state the
 * production schema would have rejected.
 */
export function createInMemoryIntentStore(): IntentStore & { rows: UploadIntentRecord[] } {
  const rows: UploadIntentRecord[] = [];
  let seq = 0;

  function assertInvariants(candidate: UploadIntentRecord) {
    const others = rows.filter((r) => r.id !== candidate.id);
    if (TERMINAL_UPLOADED_STATES.includes(candidate.state) &&
        others.some((r) => r.videoId === candidate.videoId &&
          TERMINAL_UPLOADED_STATES.includes(r.state))) {
      throw new Error("unique violation: one completed intent per videoId");
    }
    if (ACTIVE_STATES.includes(candidate.state) &&
        others.some((r) => r.videoId === candidate.videoId && ACTIVE_STATES.includes(r.state))) {
      throw new Error("unique violation: one active intent per videoId");
    }
    if (candidate.youtubeId &&
        others.some((r) => r.youtubeId === candidate.youtubeId)) {
      throw new Error("unique violation: youtubeId already claimed by another intent");
    }
    if (others.some((r) => r.correlationId === candidate.correlationId)) {
      throw new Error("unique violation: correlationId reused");
    }
  }

  return {
    rows,
    async findByArtifact(videoId, fileSha256, manifestSha256) {
      return rows.find(
        (r) => r.videoId === videoId && r.fileSha256 === fileSha256 &&
          r.manifestSha256 === manifestSha256,
      ) ?? null;
    },
    async findByVideo(videoId) {
      return rows.filter((r) => r.videoId === videoId);
    },
    async listUnresolved(channel) {
      return rows
        .filter((r) => isUnresolved(r.state) && (!channel || r.channel === channel))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    async create(data) {
      const now = new Date();
      const row: UploadIntentRecord = {
        provenance: "MARKER_BACKED",
        remoteMarkerPresent: true,
        fileHashVerified: true,
        manifestHashVerified: true,
        inferredFileSha256: null,
        inferredManifestSha256: null,
        evidenceNote: null,
        ...data,
        id: `intent-${++seq}`,
        state: "PREPARED",
        youtubeId: null,
        remoteEtag: null,
        remotePublishedAt: null,
        adopted: false,
        attempts: 0,
        lastError: null,
        reconcileNote: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      assertInvariants(row);
      rows.push(row);
      return { ...row };
    },
    async update(id, patch) {
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) throw new Error(`no intent ${id}`);
      const next = { ...rows[idx]!, ...patch, updatedAt: new Date() };
      assertInvariants(next);
      rows[idx] = next;
      return { ...next };
    },
  };
}

// ── Google adapter ───────────────────────────────────────────────────────

/** ISO-8601 duration (PT7M16S) → seconds. */
export function iso8601DurationToSeconds(d: string | null | undefined): number | null {
  if (!d) return null;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d);
  if (!m) return null;
  const [, days, hours, mins, secs] = m;
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 +
    Number(mins ?? 0) * 60 + Number(secs ?? 0)
  );
}

/**
 * Real YouTube port, built from the shared authentication constructor so the
 * uploader and the reconciler are provably the same identity.
 */
export function createGoogleYouTubePort(): YouTubePort {
  const yt = buildYouTubeClient();

  async function toRemote(id: string): Promise<RemoteVideo | null> {
    const res = await yt.videos.list({ part: ["snippet", "status", "contentDetails"], id: [id] });
    const v = res.data.items?.[0];
    if (!v) return null;
    return {
      id: v.id!,
      title: v.snippet?.title ?? null,
      tags: v.snippet?.tags ?? [],
      privacyStatus: v.status?.privacyStatus ?? null,
      publishAt: (v.status as { publishAt?: string } | undefined)?.publishAt ?? null,
      channelId: v.snippet?.channelId ?? null,
      durationS: iso8601DurationToSeconds(v.contentDetails?.duration),
      etag: v.etag ?? null,
      publishedAt: v.snippet?.publishedAt ?? null,
    };
  }

  return {
    async insert(req) {
      const res = await yt.videos.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: {
            title: req.title,
            description: req.description,
            tags: req.tags,
            categoryId: req.categoryId,
          },
          status: {
            privacyStatus: req.privacyStatus,
            ...(req.publishAt ? { publishAt: req.publishAt } : {}),
            selfDeclaredMadeForKids: false,
          },
        },
        media: { body: createReadStream(req.filePath) },
      });
      const id = res.data.id;
      if (!id) throw new Error("videos.insert returned no id");
      return { id, etag: res.data.etag ?? null, publishedAt: res.data.snippet?.publishedAt ?? null };
    },

    async listChannelUploads() {
      const me = await yt.channels.list({ part: ["contentDetails"], mine: true });
      const playlistId = me.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) return [];

      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await yt.playlistItems.list({
          part: ["snippet"], playlistId, maxResults: 50, pageToken,
        });
        for (const item of page.data.items ?? []) {
          const id = item.snippet?.resourceId?.videoId;
          if (id) ids.push(id);
        }
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);

      // Tags are only returned by videos.list, so hydrate in batches of 50.
      const out: RemoteVideo[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const res = await yt.videos.list({
          part: ["snippet", "status", "contentDetails"], id: batch, maxResults: 50,
        });
        for (const v of res.data.items ?? []) {
          out.push({
            id: v.id!,
            title: v.snippet?.title ?? null,
            tags: v.snippet?.tags ?? [],
            privacyStatus: v.status?.privacyStatus ?? null,
            publishAt: (v.status as { publishAt?: string } | undefined)?.publishAt ?? null,
            channelId: v.snippet?.channelId ?? null,
            durationS: iso8601DurationToSeconds(v.contentDetails?.duration),
            etag: v.etag ?? null,
            publishedAt: v.snippet?.publishedAt ?? null,
          });
        }
      }
      return out;
    },

    getVideo: toRemote,
  };
}

// ── Upload disposition ───────────────────────────────────────────────────

/**
 * What is actually known about whether an asset reached YouTube.
 *
 * `youtubeId IS NULL` collapses four very different situations into one, and
 * reporting all of them as "never uploaded" is what let uVQ-vcJHWNk sit
 * unnoticed on a live channel while the invariant suite showed a green tick.
 */
export type UploadDisposition =
  /** No local id, no intent, nothing remote carrying this asset's identity. */
  | "VERIFIED_NOT_UPLOADED"
  /** Local id present and confirmed. */
  | "VERIFIED_UPLOADED_AND_PERSISTED"
  /** Remote holds it; local persistence never happened. */
  | "VERIFIED_REMOTE_ORPHAN"
  /** A pre-marker remote video adopted retrospectively; binding inferred. */
  | "VERIFIED_HISTORICAL_REMOTE_ADOPTION"
  /** An intent records that a call may have been made; remote unchecked or silent. */
  | "UPLOAD_OUTCOME_UNKNOWN"
  /** Explicitly flagged for a human. */
  | "RECONCILIATION_REQUIRED";

export interface DispositionInput {
  localYoutubeId: string | null | undefined;
  intents: UploadIntentRecord[];
  /** Remote videos independently believed to be this asset. */
  remoteMatches: RemoteVideo[];
}

export interface DispositionResult {
  disposition: UploadDisposition;
  detail: string;
  /** True when the suite must fail closed. */
  blocking: boolean;
  remoteIds: string[];
}

export function classifyUploadDisposition(i: DispositionInput): DispositionResult {
  const remoteIds = i.remoteMatches.map((v) => v.id);
  const needsHuman = i.intents.find((x) => x.state === "RECONCILIATION_REQUIRED");
  if (needsHuman) {
    return {
      disposition: "RECONCILIATION_REQUIRED",
      detail: needsHuman.reconcileNote ?? `intent ${needsHuman.id} flagged for reconciliation`,
      blocking: true,
      remoteIds,
    };
  }

  if (isRealId(i.localYoutubeId)) {
    const historical = i.intents.find((x) => x.state === "RECONCILED_HISTORICAL_UPLOAD");
    if (historical) {
      return {
        disposition: "VERIFIED_HISTORICAL_REMOTE_ADOPTION",
        detail:
          `youtubeId=${i.localYoutubeId} adopted retrospectively via intent ${historical.id}; ` +
          `remote marker present=${historical.remoteMarkerPresent}, ` +
          `file hash verified=${historical.fileHashVerified}, ` +
          `manifest hash verified=${historical.manifestHashVerified}`,
        blocking: false,
        remoteIds,
      };
    }
    const persisted = i.intents.find((x) => x.state === "PERSISTED");
    return {
      disposition: "VERIFIED_UPLOADED_AND_PERSISTED",
      detail: persisted
        ? `youtubeId=${i.localYoutubeId} via intent ${persisted.id}`
        : `youtubeId=${i.localYoutubeId} (no intent row — predates durable intents)`,
      blocking: false,
      remoteIds,
    };
  }

  if (remoteIds.length > 0) {
    return {
      disposition: "VERIFIED_REMOTE_ORPHAN",
      detail:
        `${remoteIds.length} remote video(s) match this asset but no local record carries the id: ` +
        remoteIds.join(", "),
      blocking: true,
      remoteIds,
    };
  }

  const open = i.intents.find((x) => isUnresolved(x.state));
  if (open) {
    return {
      disposition: "UPLOAD_OUTCOME_UNKNOWN",
      detail: `intent ${open.id} is ${open.state}; remote outcome not established`,
      blocking: true,
      remoteIds,
    };
  }

  return {
    disposition: "VERIFIED_NOT_UPLOADED",
    detail: "no local id, no open intent, no matching remote video",
    blocking: false,
    remoteIds,
  };
}
