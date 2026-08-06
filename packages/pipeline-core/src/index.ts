// ── Types ──────────────────────────────────────────────────────────────────
export type {
  ScriptSegment,
  Script,
  Chapter,
  SEOMetadata,
  PipelineContext,
  StageResult,
  StageFn,
  StageDefinition,
  FeedItem,
  VoiceoverResult,
  AssemblyResult,
  UploadResult,
} from "./types";

// ── Config ─────────────────────────────────────────────────────────────────
export { env } from "./config";
export type { Env } from "./config";

// ── YouTube Auth ───────────────────────────────────────────────────────────
export {
  buildYouTubeAuth,
  buildYouTubeClient,
  resolveYouTubeCredential,
  describeCredentialSource,
  authPreflight,
  CredentialResolutionError,
  verifyChannel,
  CHANNELS,
} from "./youtubeAuth";
export type {
  ChannelKey,
  ChannelSpec,
  CredentialSource,
  ResolvedCredential,
  AuthPreflightResult,
} from "./youtubeAuth";

// ── Durable upload intent ──────────────────────────────────────────────────
export {
  CORRELATION_TAG_PREFIX,
  correlationTag,
  correlationIdFromTags,
  newCorrelationId,
  metadataFingerprint,
  isUnresolved,
  prismaIntentStore,
  assertUploadable,
  reconcileIntent,
  reconcileAll,
  guardedUpload,
  createInMemoryIntentStore,
  createGoogleYouTubePort,
  iso8601DurationToSeconds,
  UploadBlockedError,
  classifyUploadDisposition,
  TERMINAL_UPLOADED_STATES,
} from "./lib/uploadIntent";
export type {
  UploadIntentRecord,
  NewUploadIntent,
  IntentStore,
  RemoteVideo,
  InsertRequest,
  YouTubePort,
  UploadMetadata,
  UploadGuardInput,
  ReconcileOutcome,
  ReconcileDeps,
  GuardedUploadInput,
  GuardedUploadDeps,
  GuardedUploadResult,
  UploadDisposition,
  DispositionInput,
  DispositionResult,
} from "./lib/uploadIntent";

// ── Lib ────────────────────────────────────────────────────────────────────
export { prisma, disconnect } from "./lib/db";
export { withAdvisoryLock } from "./lib/lock";
export { withRetry } from "./lib/retry";
export { createMessage } from "./lib/anthropic";
export { fetchLibraryTopic } from "./lib/topicLibrary";
export type { LibraryTopic } from "./lib/topicLibrary";
export { RunSummary } from "./lib/pipelineRun";
export type {
  PipelineChannel,
  PipelineMode,
  PipelineRunStatusValue,
} from "./lib/pipelineRun";

// ── ElevenLabs (TTS + usage accounting + idempotency) ─────────────────────
export {
  synthesizeSegment,
  scriptHashFor,
  creditsChargedFor,
  generationIdsFor,
  ELEVEN_MODEL,
  ELEVEN_OUTPUT_FORMAT,
  ELEVEN_STABILITY,
  ELEVEN_SIMILARITY,
} from "./lib/elevenlabs";
export type { Alignment, SynthesisResult } from "./lib/elevenlabs";

// ── Credit budget ─────────────────────────────────────────────────────────
export {
  reserveCredits,
  settleCredits,
  setBudgetLimit,
  currentBudgetLimit,
  withBudgetWindow,
  budgetReport,
  BudgetExceededError,
  TOTAL_TARGET_CHARS,
} from "./lib/budget";
export type { BudgetReport } from "./lib/budget";

// ── Circuit breaker ───────────────────────────────────────────────────────
export {
  tripBreaker,
  assertCircuitClosed,
  clearBreaker,
  breakerStatus,
  checkRenderFailureRate,
  CircuitOpenError,
  GLOBAL as BREAKER_GLOBAL,
} from "./lib/circuitBreaker";
export type { BreakerTrigger } from "./lib/circuitBreaker";

// ── ffmpeg primitives ─────────────────────────────────────────────────────
export {
  FFMPEG, FFPROBE, ff, ffRaw, ffprobeJson,
  headerDuration, decodedDuration, videoDuration, mediaInfo,
  buildNarrationTrack, detectSilence, volumeStats,
  blackFrameStats, frozenRunSeconds, extractFrame,
} from "./lib/ffmpeg";
export type { MediaInfo, NarrationTrack } from "./lib/ffmpeg";

// ── Captions ──────────────────────────────────────────────────────────────
export {
  wordsFromAlignment, cuesFromWords, wrapCue, renderASS, formatASSTime,
  buildLongformCaptions, buildShortsCaptions,
  LONGFORM_STYLE, SHORTS_STYLE, SUBTITLE_MAX_CHARS_PER_LINE,
} from "./lib/captions";
export type { Word, Cue, AssStyle, BuiltCaptions } from "./lib/captions";

// ── Visuals ───────────────────────────────────────────────────────────────
export {
  searchPexelsCandidates, validateCandidateMeta, validateDownloadedClip,
  AssetLedger, recordScene, sceneRecordsFor, wrapCardText, writeCardTextFile,
  MIN_WIDTH, MIN_HEIGHT, MIN_CLIP_SECONDS,
} from "./lib/visuals";
export type { Candidate, ValidationOutcome, SceneRecordInput } from "./lib/visuals";

// ── Visual semantic relevance ─────────────────────────────────────────────
export {
  scoreRelevance, describeFromPexelsUrl, narrationIsAboutVoiceAI,
  VisualPlan, REJECT_THRESHOLD, buildSearchQueries,
  classifyConcept,
  AI_SUBJECTS,
  MARINE_SUBJECTS,
} from "./lib/visualRelevance";
export type { RelevanceInput, RelevanceResult, Verdict } from "./lib/visualRelevance";

// ── Synchronisation anchors ───────────────────────────────────────────────
export {
  extractSyncAnchors, formatAnchors, locatePhrase,
  findDiagnosticMarkers, containsDiagnosticMarkers, DIAGNOSTIC_MARKER_PATTERNS,
} from "./lib/syncAnchors";
export type { SyncAnchor } from "./lib/syncAnchors";

// ── Runtime targets ───────────────────────────────────────────────────────
export {
  runtimeRange, checkRuntime, charsForRuntime, fmt as fmtRuntime,
  CONFIGURED_RANGE, OBSERVED_RANGE, CHARS_PER_SECOND, TITLE_CARD_S,
  RuntimeTargetError,
} from "./lib/runtimeTargets";
export type { RuntimeRange, RuntimeCheck, Format } from "./lib/runtimeTargets";

// ── Visual beats & brand guard ────────────────────────────────────────────
export {
  planVisualBeats, planSegmentBeats, summarizeBeats, minimumBeatsFor,
  BEAT_TARGET_S, BEAT_MIN_S, BEAT_MAX_S, MIN_FRAGMENT_S,
} from "./lib/visualBeats";
export type { VisualBeat, BeatPlanSummary } from "./lib/visualBeats";
export {
  checkBrandFromMetadata, brandCheckFromFrameInspection, brandAdmits,
  narrationMentionsBrand, isHighBrandRiskFootage,
} from "./lib/brandGuard";
export type { BrandCheck, BrandDecision } from "./lib/brandGuard";

// ── Pre-TTS visual feasibility gate ───────────────────────────────────────
export {
  assessVisualFeasibility, assertVisuallyFeasible, planPreliminaryBeats,
  feasibilityQueries, pexelsOnlySource, formatFeasibility,
  withVisualFeasibilityGate, VisualFeasibilityError,
  MAX_CARD_SHARE, POOL_SAFETY_FACTOR, DURATION_SAFETY_FACTOR,
  MAX_CONCEPT_SHARE, MIN_DISTINCT_CONCEPTS,
} from "./lib/visualFeasibility";
export type {
  FeasibilityInput, FeasibilityDeps, FeasibilityReport, FeasibilityCheck,
  OutlineSegment, PredictedBeat,
} from "./lib/visualFeasibility";

// ── Immutable approved artifact ───────────────────────────────────────────
export {
  sha256File, sha256Manifest, storeApproval, verifyApproved, ArtifactMismatchError,
} from "./lib/approvedArtifact";
export type { ApprovedArtifact, SceneManifestEntry } from "./lib/approvedArtifact";

// ── QA ────────────────────────────────────────────────────────────────────
export {
  runQa, persistQa, formatQa, measureCaptionOffsets,
  AV_DURATION_TOLERANCE_S, CAPTION_OFFSET_TOLERANCE_S,
} from "./lib/qa";
export type { QaInput, QaResult, Check, Severity } from "./lib/qa";

// ── Thumbnail ─────────────────────────────────────────────────────────────
export { createSubjectLayer } from "./thumbnail/subjectLayer";
export type { SubjectLayerResult } from "./thumbnail/subjectLayer";

// ── Model-response classification ─────────────────────────────────────────
export {
  classifyModelResponse, promptHash, recordScriptFailure,
  priorAttemptsForPrompt, isRetryable, NON_RETRYABLE,
} from "./lib/modelResponse";
export type { Classification } from "./lib/modelResponse";

// ── Shorts hook window ────────────────────────────────────────────────────
export {
  resolveHookWindow,
  validateHookWindow,
  normalizeToken,
  HookAlignmentError,
} from "./lib/hookWindow";
export type { HookWindow, ResolveHookOptions } from "./lib/hookWindow";

// ── Job quarantine ────────────────────────────────────────────────────────
export {
  quarantineJob,
  releaseQuarantine,
  quarantinedVideoIds,
  resumableJobs,
  RESUMABLE_STATUSES,
  QUARANTINE_STATUS,
  QUARANTINE_PREFIX,
} from "./lib/quarantine";
export type { QuarantineInput, QuarantineResult } from "./lib/quarantine";

// ── Upload safety ─────────────────────────────────────────────────────────
export {
  prepareUpload,
  confirmUploadState,
  assertNoDuplicateUploadRecord,
  isRealYoutubeId,
} from "./lib/uploadSafety";
export type { UploadDecision } from "./lib/uploadSafety";

// ── Test stage / run classification ───────────────────────────────────────
export { currentTestStage, isTestStage } from "./lib/testStage";

// ── Shared Stages ──────────────────────────────────────────────────────────
export { voiceover } from "./stages/voiceover";
export { runVoiceover, readManifest, readAlignments, manifestPath } from "./stages/voiceoverShared";
export type { NarrationManifest, VoiceoverDeps } from "./stages/voiceoverShared";
export { videoAssembly } from "./stages/videoAssembly";
export { runAssembly, cleanupAssemblyTmp, TITLE_CARD_DURATION, DURATION_TOLERANCE } from "./stages/assemblyShared";
export type { AssemblyOutcome, AssemblyDeps } from "./stages/assemblyShared";
export { youtubeUpload } from "./stages/youtubeUpload";
export { thumbnailGenerator } from "./stages/thumbnailGenerator";
export { notify } from "./stages/notify";

// ── Beat-level semantic coverage ───────────────────────────────────────────
export {
  FAMILIES, POLYSEMY, familiesIn, resolveSense, deriveRequirement,
  scoreSemantic, coverBeat, assessSemanticCoverage,
  buildBeatQueries, stripFraming, derivePolicy, composeBeat,
  MIN_SUBJECT_SHARE, MIN_SUBJECT_SHARE_DOMINANT, MIN_SETTING_SHARE,
} from "./lib/semanticCoverage";
export type {
  Family, Sense, BeatRequirement, SemanticVerdict, SemanticScore,
  CandidateLike, QueryProvenance, BeatCoverage, SemanticCoverageOptions,
  SemanticFeasibility, QueryClass, BeatQuery, CompositionPolicy,
  Fragment, CompositionResult,
} from "./lib/semanticCoverage";

// ── Brand-risk normalisation ───────────────────────────────────────────────
export { normaliseBrandRisk } from "./lib/brandRisk";
export type { BrandRisk, BrandRiskNormalisation } from "./lib/brandRisk";

// ── Quality profiles ───────────────────────────────────────────────────────
export {
  qualityProfile, NON_NEGOTIABLE,
  PREMIUM_AUTOMATED_VISUAL_QUALITY, FINITE_CREDIT_BURN_ACCEPTABLE_QUALITY,
} from "./lib/qualityProfile";
export type { QualityProfile, QualityProfileName } from "./lib/qualityProfile";

// ── Approved allocation ────────────────────────────────────────────────────
export {
  approvedAllocationHash, realizedTimelineHash, alignToNarration,
  validateTimingEnvelope, assertRealizedMatchesApproved, AllocationConflictError,
  MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, solvePlaybackRates,
} from "./lib/approvedAllocation";
export {
  buildSpokenUnits, spokenScriptText, spokenCharacterCount, spokenOutlineSegments,
  SPOKEN_UNIT_SEPARATOR,
} from "./lib/spokenUnits";
export type { SpokenUnit, SpokenUnitPart } from "./lib/spokenUnits";
export {
  planExhaustiveBeats, verifyExhaustive, splitSentences, beatCountFor,
} from "./lib/exhaustiveBeats";
export type { ExhaustiveBeat } from "./lib/exhaustiveBeats";
export { solveApprovedStrip, MAX_CLIP_S } from "./lib/approvedStrip";
export {
  activePilotId, getPilot, currentPilot, assertRunnable, remainingSlots,
  claimPilotSlot, releasePilotSlot, confirmPilotSlot,
  uploadPolicyFor, assertPilotUploadAllowed, PilotBlockedError,
} from "./lib/pilot";
export type { PilotConfig, PilotStatus, UploadPolicy } from "./lib/pilot";
export {
  zonedParts, offsetMinutes, isDst, zonedTimeToUtc, isWindowDay, isInWindow,
  nextWindowStart, formatZoned, EASTERN,
  DEFAULT_WINDOW_DAYS, DEFAULT_WINDOW_START_HOUR, DEFAULT_WINDOW_END_HOUR,
} from "./lib/easternWindow";
export type { StripAsset, StripBeat } from "./lib/approvedStrip";
export {
  beatSpansForUnit, beatSpansForNarration, AlignmentError,
} from "./lib/narrationAlignment";
export type { BeatRange, BeatSpan, UnitInput } from "./lib/narrationAlignment";
export type {
  ApprovedAllocation, ApprovedBeat, ApprovedFragment,
  RealizedTimeline, RealizedFragment,
} from "./lib/approvedAllocation";
