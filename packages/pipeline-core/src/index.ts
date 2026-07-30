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
  verifyChannel,
  CHANNELS,
} from "./youtubeAuth";
export type { ChannelKey, ChannelSpec } from "./youtubeAuth";

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

// ── QA ────────────────────────────────────────────────────────────────────
export {
  runQa, persistQa, formatQa, measureCaptionOffsets,
  AV_DURATION_TOLERANCE_S, CAPTION_OFFSET_TOLERANCE_S,
} from "./lib/qa";
export type { QaInput, QaResult, Check, Severity } from "./lib/qa";

// ── Thumbnail ─────────────────────────────────────────────────────────────
export { createSubjectLayer } from "./thumbnail/subjectLayer";
export type { SubjectLayerResult } from "./thumbnail/subjectLayer";

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
