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

// ── Thumbnail ─────────────────────────────────────────────────────────────
export { createSubjectLayer } from "./thumbnail/subjectLayer";
export type { SubjectLayerResult } from "./thumbnail/subjectLayer";

// ── Shared Stages ──────────────────────────────────────────────────────────
export { voiceover } from "./stages/voiceover";
export { videoAssembly } from "./stages/videoAssembly";
export { youtubeUpload } from "./stages/youtubeUpload";
export { thumbnailGenerator } from "./stages/thumbnailGenerator";
export { notify } from "./stages/notify";
