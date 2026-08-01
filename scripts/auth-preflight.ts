/**
 * Read-only YouTube authentication preflight.
 *
 *   npx tsx scripts/auth-preflight.ts [channelKey]
 *
 * Resolves the credential through the SAME `buildYouTubeAuth()` the uploader,
 * the duplicate guard and the reconciler use. A standalone script that
 * authenticates by its own route proves nothing about the upload path — that
 * gap is exactly how a valid token file sat unused while the pipeline
 * authenticated with a revoked environment credential.
 *
 * Read-only: `channels.list(mine)` only. Never prints token material.
 * Exits non-zero on any failure, including a channel mismatch.
 */
import { authPreflight, CHANNELS } from "@yt-pipeline/pipeline-core";
import type { ChannelKey } from "@yt-pipeline/pipeline-core";
import "dotenv/config";

async function main() {
  const key = (process.argv[2] ?? "ai-doom-scroll") as ChannelKey;
  const expected = CHANNELS[key];
  if (!expected) {
    console.error(`unknown channel "${key}" — expected one of ${Object.keys(CHANNELS).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log("\n═══ YOUTUBE AUTH PREFLIGHT (read-only) ═══\n");
  console.log(`  expected channel : ${expected.title} (${expected.id})`);

  const r = await authPreflight(expected);

  const line = (label: string, value: unknown, ok?: boolean) =>
    console.log(`  ${ok === undefined ? " " : ok ? "✓" : "✗"} ${label.padEnd(26)} ${value}`);

  line("credential source", r.source, r.source === "token_file" || r.source === "environment");
  if (r.tokenFilePath) line("token file", r.tokenFilePath);
  line("refresh token present", r.refreshTokenPresent ? "yes" : "no", r.refreshTokenPresent);
  line("access token obtainable", r.accessTokenObtainable ? "yes" : "no", r.accessTokenObtainable);
  line("invalid_grant", r.invalidGrant ? "YES" : "no", !r.invalidGrant);
  line("channel name", r.channelTitle ?? "(none)", Boolean(r.channelTitle));
  line("channel id", r.channelId ?? "(none)", Boolean(r.channelId));
  line(
    "matches expected channel",
    r.matchesExpectedChannel === null ? "n/a" : r.matchesExpectedChannel ? "yes" : "NO",
    r.matchesExpectedChannel !== false,
  );
  if (r.error) console.log(`\n  error: ${r.error}`);

  const ok =
    r.refreshTokenPresent &&
    r.accessTokenObtainable &&
    !r.invalidGrant &&
    r.matchesExpectedChannel === true &&
    !r.error;

  console.log(ok ? "\n  ✓ AUTH PREFLIGHT PASSED\n" : "\n  ✗ AUTH PREFLIGHT FAILED\n");
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error("PREFLIGHT ERROR:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
