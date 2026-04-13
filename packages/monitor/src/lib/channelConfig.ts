import { env } from "../config";

/**
 * Per-channel configuration for things that cannot live in the DB
 * (subreddit lists, content-domain descriptions for Claude prompts, etc.).
 */
export interface ChannelConfig {
  /** Subreddits scraped daily by redditScraper for topic seeds. */
  scrapeSubreddits: string[];
  /** Keyword → [subreddits] routing for auto-post selection. Leave empty for default-only. */
  postSubredditMap: Record<string, string[]>;
  /** Fallback subreddit when no keyword matches (or when postSubredditMap is empty). */
  defaultPostSubreddit: string;
  /** Short human-readable description of channel content domain — used in Claude prompts. */
  contentDescription: string;
}

export const CHANNEL_CONFIGS = {
  "ai-doom-scroll": {
    scrapeSubreddits: ["artificial", "MachineLearning", "ChatGPT"],
    postSubredditMap: {
      ai: ["artificial", "ChatGPT"],
      llm: ["artificial", "MachineLearning"],
      openai: ["ChatGPT", "artificial"],
      anthropic: ["artificial", "MachineLearning"],
      google: ["artificial", "ChatGPT"],
      model: ["MachineLearning", "artificial"],
      agent: ["artificial", "ChatGPT"],
    },
    defaultPostSubreddit: "artificial",
    contentDescription: "AI and technology news for a general audience",
  },
  "wet-circuit": {
    scrapeSubreddits: [
      "kayakfishing",
      "fishingelectronics",
      "electronics",
      "Garmin",
      "AskElectronics",
    ],
    postSubredditMap: {},
    defaultPostSubreddit: "fishingelectronics",
    contentDescription:
      "Marine electronics — fishfinders, chartplotters, sonar/livescope, trolling motors, and boating tech",
  },
} as const satisfies Record<string, ChannelConfig>;

export function getChannelConfig(): ChannelConfig {
  return CHANNEL_CONFIGS[env().CHANNEL];
}
