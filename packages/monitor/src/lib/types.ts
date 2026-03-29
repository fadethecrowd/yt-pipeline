// ── Enums (local definitions, not from @prisma/client) ──────────────────

export const ActionType = {
  PIN_COMMENT: "PIN_COMMENT",
  HEART_COMMENT: "HEART_COMMENT",
  REPLY_COMMENT: "REPLY_COMMENT",
  UPDATE_TITLE: "UPDATE_TITLE",
  UPDATE_DESCRIPTION: "UPDATE_DESCRIPTION",
  UPDATE_TAGS: "UPDATE_TAGS",
  REGENERATE_THUMBNAIL: "REGENERATE_THUMBNAIL",
  COMMUNITY_POST: "COMMUNITY_POST",
  END_SCREEN: "END_SCREEN",
  REPROMOTE: "REPROMOTE",
  REDDIT_POST: "REDDIT_POST",
  GENERATE_SHORT: "GENERATE_SHORT",
  ALERT: "ALERT",
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

// Actions that must always go through Telegram approval — never auto-execute
export const REQUIRES_APPROVAL: ReadonlySet<ActionType> = new Set([
  ActionType.UPDATE_TITLE,
  ActionType.UPDATE_TAGS,
  ActionType.UPDATE_DESCRIPTION,
  ActionType.REGENERATE_THUMBNAIL,
  ActionType.REPLY_COMMENT,
  ActionType.COMMUNITY_POST,
  ActionType.REPROMOTE,
  ActionType.REDDIT_POST,
]);

export const ActionStatus = {
  PENDING: "PENDING",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  EXECUTED: "EXECUTED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
} as const;
export type ActionStatus = (typeof ActionStatus)[keyof typeof ActionStatus];

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

// ── Benchmarks ──────────────────────────────────────────────────────────

export interface BootstrapBenchmarks {
  avgCtr: number;
  avgViewDuration: number;
  avgViews48hr: number;
  avgSubsPerVideo: number;
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
  ANTHROPIC_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  POLL_INTERVAL_MS: number;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USERNAME?: string;
  REDDIT_PASSWORD?: string;
  REDDIT_USER_AGENT?: string;
}
