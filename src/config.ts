import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  ANTHROPIC_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID: z.string().min(1),
  PEXELS_API_KEY: z.string().min(1),
  YOUTUBE_CLIENT_ID: z.string().min(1),
  YOUTUBE_CLIENT_SECRET: z.string().min(1),
  YOUTUBE_REFRESH_TOKEN: z.string().min(1),

  NODE_ENV: z.enum(["development", "production"]).default("development"),
  PIPELINE_LOCK_ID: z.coerce.number().default(123456),
  QUALITY_THRESHOLD: z.coerce.number().min(0).max(100).default(75),
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
