import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  ANTHROPIC_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  PEXELS_API_KEY: z.string().min(1),
  YOUTUBE_CLIENT_ID: z.string().min(1),
  YOUTUBE_CLIENT_SECRET: z.string().min(1),
  // Exactly one credential source is required; see the superRefine below.
  // YOUTUBE_TOKEN_FILE is the local path (authoritative when set),
  // YOUTUBE_REFRESH_TOKEN is the deployed/Railway path.
  YOUTUBE_REFRESH_TOKEN: z.string().min(1).optional(),
  YOUTUBE_TOKEN_FILE: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.coerce.string().optional(),

  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PIPELINE_LOCK_ID: z.coerce.number().default(123456),
  QUALITY_THRESHOLD: z.coerce.number().min(0).max(100).default(75),
}).superRefine((v, ctx) => {
  // Railway sets YOUTUBE_REFRESH_TOKEN and no token file, so it stays
  // effectively required there. A machine that configures YOUTUBE_TOKEN_FILE
  // may omit the env var entirely.
  if (!v.YOUTUBE_TOKEN_FILE && !v.YOUTUBE_REFRESH_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["YOUTUBE_REFRESH_TOKEN"],
      message:
        "no YouTube credential configured — set YOUTUBE_TOKEN_FILE (local) or YOUTUBE_REFRESH_TOKEN (deployed)",
    });
  }
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function env(): Env {
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
