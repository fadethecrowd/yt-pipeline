import { z } from "zod";
import type { MonitorConfig } from "./lib/types";

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  YOUTUBE_API_KEY: z.string().optional(),
  YOUTUBE_CLIENT_ID: z.string().min(1),
  YOUTUBE_CLIENT_SECRET: z.string().min(1),
  YOUTUBE_REFRESH_TOKEN: z.string().min(1),
  YOUTUBE_CHANNEL_ID: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.coerce.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().default(900_000), // 15 min
  // Reddit auto-posting (optional — disabled if not set)
  REDDIT_CLIENT_ID: z.string().min(1).optional(),
  REDDIT_CLIENT_SECRET: z.string().min(1).optional(),
  REDDIT_USERNAME: z.string().min(1).optional(),
  REDDIT_PASSWORD: z.string().min(1).optional(),
  REDDIT_USER_AGENT: z.string().min(1).optional(),
});

let _env: MonitorConfig | null = null;

export function env(): MonitorConfig {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const missing = result.error.issues
        .map((i) => i.path.join("."))
        .join(", ");
      throw new Error(`Missing or invalid env vars: ${missing}`);
    }
    _env = result.data;
  }
  return _env;
}
