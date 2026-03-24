import type { Topic, Video } from "@prisma/client";

// ── Script Structure ───────────────────────────────────────────────────────

export interface ScriptSegment {
  segmentIndex: number;
  title: string;
  narration: string; // voiceover text
  visual_prompt: string; // description of what to show on screen
  duration_seconds: number; // estimated duration
}

export interface Script {
  hook: string;
  segments: ScriptSegment[];
  cta: string;
  estimatedTotalDuration: number;
}

// ── SEO ────────────────────────────────────────────────────────────────────

export interface Chapter {
  time: string; // "0:00" format
  label: string;
}

export interface SEOMetadata {
  title: string;
  description: string;
  tags: string[];
  chapters: Chapter[];
}

// ── Pipeline ───────────────────────────────────────────────────────────────

export interface PipelineContext {
  topic: Topic;
  video: Video;
  script?: Script;
  voiceoverUrls?: string[];
  videoUrl?: string;
  thumbnailA?: string;
  thumbnailB?: string;
  thumbnailC?: string;
  seo?: SEOMetadata;
  youtubeId?: string;
}

export interface StageResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  durationMs: number;
}

export type StageFn = (ctx: PipelineContext) => Promise<StageResult>;

export interface StageDefinition {
  name: string;
  execute: StageFn;
  retries: number;
}

// ── Topic Discovery ────────────────────────────────────────────────────────

export interface FeedItem {
  title: string;
  url: string;
  source: string;
  summary?: string;
  publishedAt?: Date;
}

// ── Voiceover ──────────────────────────────────────────────────────────────

export interface VoiceoverResult {
  segmentIndex: number;
  url: string; // URL to generated MP3
  durationMs: number;
}

// ── Video Assembly ─────────────────────────────────────────────────────────

export interface AssemblyResult {
  videoPath: string;
}

// ── YouTube Upload ─────────────────────────────────────────────────────────

export interface UploadResult {
  youtubeId: string;
  scheduledAt: Date;
}
