import type { ActionType } from "@prisma/client";

// ── YouTube API response shapes ─────────────────────────────────────────

export interface VideoMetrics {
  videoId: string;
  youtubeId: string;
  views: number;
  likes: number;
  comments: number;
  ctr?: number;
  avgViewDuration?: number;
}

export interface YouTubeComment {
  youtubeCommentId: string;
  videoId: string;
  authorName: string;
  authorChannel?: string;
  text: string;
  likeCount: number;
  publishedAt: Date;
}

// ── Decision engine ─────────────────────────────────────────────────────

export interface Decision {
  videoId: string;
  type: ActionType;
  payload: Record<string, unknown>;
  reason: string;
}

export interface ActionResult {
  success: boolean;
  message: string;
}

// ── Digest ──────────────────────────────────────────────────────────────

export interface DigestEntry {
  videoTitle: string;
  youtubeId: string;
  views: number;
  viewsDelta: number;
  likes: number;
  likesDelta: number;
  comments: number;
  commentsDelta: number;
}

// ── Config ──────────────────────────────────────────────────────────────

export interface MonitorConfig {
  DATABASE_URL: string;
  YOUTUBE_API_KEY?: string;
  YOUTUBE_CLIENT_ID: string;
  YOUTUBE_CLIENT_SECRET: string;
  YOUTUBE_REFRESH_TOKEN: string;
  YOUTUBE_CHANNEL_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  POLL_INTERVAL_MS: number;
}
