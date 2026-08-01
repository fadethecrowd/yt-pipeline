import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { env } from "./config";

export interface ChannelSpec {
  key: ChannelKey;
  id: string;
  title: string;
}

export const CHANNELS = {
  "wet-circuit": {
    key: "wet-circuit",
    id: "UC9iJDqlrKEs0uuMeIjb9DVA",
    title: "Wet Circuit",
  },
  "ai-doom-scroll": {
    key: "ai-doom-scroll",
    id: "UCSbJfiA1aobp6G_rgwbHPMw",
    title: "AI Doom Scroll",
  },
} as const;

export type ChannelKey = "wet-circuit" | "ai-doom-scroll";

// ── Credential resolution ────────────────────────────────────────────────
//
// The OAuth helper writes a credential to token-<channel>.json, but every
// runtime path used to read YOUTUBE_REFRESH_TOKEN from the environment. The
// two silently diverged: the local .env held a revoked token that returned
// invalid_grant while the freshly minted token file sat unused. A repaired
// credential that nothing reads is not a repaired credential.
//
// Resolution order:
//   1. YOUTUBE_TOKEN_FILE, when explicitly configured — authoritative.
//   2. YOUTUBE_REFRESH_TOKEN from the environment — the Railway path.
//
// Railway does not set YOUTUBE_TOKEN_FILE, so its behaviour is unchanged.

export type CredentialSource = "token_file" | "environment";

export interface ResolvedCredential {
  source: CredentialSource;
  /** Never logged, never returned to a caller that prints. */
  refreshToken: string;
  /** Absolute path, only set for `token_file`. */
  tokenFilePath?: string;
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

/**
 * Load and validate the credential this process must authenticate with.
 *
 * Fails closed and never includes token material in an error message — the
 * path and the reason are enough to diagnose every failure mode.
 */
export function resolveYouTubeCredential(): ResolvedCredential {
  const config = env();
  const configured = config.YOUTUBE_TOKEN_FILE?.trim();

  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);

    let mode: number;
    try {
      mode = statSync(path).mode;
    } catch {
      throw new CredentialResolutionError(
        `YOUTUBE_TOKEN_FILE is set to ${path} but no such file exists. ` +
          `Generate it with \`npx tsx get-youtube-token.ts\`, or unset YOUTUBE_TOKEN_FILE ` +
          `to fall back to YOUTUBE_REFRESH_TOKEN.`,
      );
    }

    // Group/other must have no access — a credential readable by another
    // account on this machine is not a credential.
    const permissive = mode & 0o077;
    if (permissive !== 0) {
      throw new CredentialResolutionError(
        `Credential file ${path} has unsafe permissions ` +
          `(${(mode & 0o777).toString(8)}); expected 600. Run \`chmod 600 ${path}\`.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new CredentialResolutionError(
        `Credential file ${path} is not valid JSON. Regenerate it with the OAuth helper.`,
      );
    }

    const refreshToken = (parsed as { refresh_token?: unknown } | null)?.refresh_token;
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      throw new CredentialResolutionError(
        `Credential file ${path} contains no refresh_token. Re-run the OAuth helper ` +
          `and approve offline access so Google returns one.`,
      );
    }

    return { source: "token_file", refreshToken, tokenFilePath: path };
  }

  const fromEnv = config.YOUTUBE_REFRESH_TOKEN;
  if (!fromEnv) {
    throw new CredentialResolutionError(
      "No YouTube credential configured: set YOUTUBE_TOKEN_FILE to a local token file " +
        "or YOUTUBE_REFRESH_TOKEN in the environment.",
    );
  }
  return { source: "environment", refreshToken: fromEnv };
}

/** Non-secret description of the active credential, safe to print. */
export function describeCredentialSource(): {
  source: CredentialSource;
  tokenFilePath?: string;
  refreshTokenPresent: boolean;
} {
  const c = resolveYouTubeCredential();
  return {
    source: c.source,
    tokenFilePath: c.tokenFilePath,
    refreshTokenPresent: c.refreshToken.length > 0,
  };
}

/**
 * The single authentication constructor. Every YouTube client in this package
 * — uploader, duplicate guard, reconciler, preflight — is built from this, so
 * a credential that passes preflight is provably the one the uploader uses.
 */
export function buildYouTubeAuth(): OAuth2Client {
  const config = env();
  const credential = resolveYouTubeCredential();
  const auth = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: credential.refreshToken });
  return auth;
}

/** A YouTube Data API client on the resolved credential. */
export function buildYouTubeClient() {
  return google.youtube({ version: "v3", auth: buildYouTubeAuth() });
}

export async function verifyChannel(
  expected: ChannelSpec,
  serviceLabel: string,
): Promise<void> {
  const auth = buildYouTubeAuth();
  const yt = google.youtube({ version: "v3", auth });
  const res = await yt.channels.list({ part: ["snippet"], mine: true });
  const channel = res.data.items?.[0];

  if (!channel) {
    throw new Error(
      `[${serviceLabel}] YouTube auth verification failed: no channel returned for current refresh token. ` +
        `This service is pinned to "${expected.title}" (${expected.id}).`,
    );
  }

  const actualId = channel.id ?? "";
  const actualTitle = (channel.snippet?.title ?? "").trim();
  const expectedTitle = expected.title.trim();
  const cred = describeCredentialSource();

  console.log(
    `[${serviceLabel}] Authenticated YouTube channel: title="${actualTitle}" id=${actualId} ` +
      `(credential source: ${cred.source}${cred.tokenFilePath ? ` ${cred.tokenFilePath}` : ""})`,
  );

  if (actualId !== expected.id) {
    const remedy =
      cred.source === "token_file"
        ? `YOUTUBE_TOKEN_FILE points at ${cred.tokenFilePath}, which authenticates as the wrong channel. ` +
          `Point it at token-${expected.key}.json, or unset it to fall back to YOUTUBE_REFRESH_TOKEN.`
        : `Set YOUTUBE_REFRESH_TOKEN on this service to the refresh_token from token-${expected.key}.json.`;
    throw new Error(
      `[${serviceLabel}] YouTube channel ID mismatch — expected id=${expected.id} ("${expected.title}"), ` +
        `but the active credential authenticates as id=${actualId} ("${actualTitle}"). ` +
        `This service is pinned to "${expected.title}" only. ${remedy}`,
    );
  }

  if (actualTitle !== expectedTitle) {
    console.warn(
      `[${serviceLabel}] Channel title differs from expected (ID matches, continuing): expected="${expectedTitle}" actual="${actualTitle}"`,
    );
  }

  console.log(
    `[${serviceLabel}] ✓ Channel verified: ${expected.title} (${expected.id})`,
  );
}

// ── Read-only authentication preflight ───────────────────────────────────

export interface AuthPreflightResult {
  source: CredentialSource;
  tokenFilePath?: string;
  refreshTokenPresent: boolean;
  accessTokenObtainable: boolean;
  channelId: string | null;
  channelTitle: string | null;
  invalidGrant: boolean;
  matchesExpectedChannel: boolean | null;
  error?: string;
}

/**
 * Resolve the authenticated identity through the *same* `buildYouTubeAuth()`
 * the uploader, duplicate guard and reconciler use. A standalone script that
 * authenticates some other way proves nothing about the upload path.
 *
 * Read-only: `channels.list(mine)` only. Never prints token material.
 */
export async function authPreflight(
  expected?: ChannelSpec,
): Promise<AuthPreflightResult> {
  const base: AuthPreflightResult = {
    source: "environment",
    refreshTokenPresent: false,
    accessTokenObtainable: false,
    channelId: null,
    channelTitle: null,
    invalidGrant: false,
    matchesExpectedChannel: expected ? false : null,
  };

  let described: ReturnType<typeof describeCredentialSource>;
  try {
    described = describeCredentialSource();
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const result: AuthPreflightResult = {
    ...base,
    source: described.source,
    tokenFilePath: described.tokenFilePath,
    refreshTokenPresent: described.refreshTokenPresent,
  };

  const auth = buildYouTubeAuth();
  try {
    const token = await auth.getAccessToken();
    result.accessTokenObtainable = Boolean(token?.token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...result, invalidGrant: /invalid_grant/i.test(message), error: message };
  }

  try {
    const yt = google.youtube({ version: "v3", auth });
    const res = await yt.channels.list({ part: ["snippet"], mine: true });
    const channel = res.data.items?.[0];
    result.channelId = channel?.id ?? null;
    result.channelTitle = (channel?.snippet?.title ?? "").trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...result, invalidGrant: /invalid_grant/i.test(message), error: message };
  }

  if (expected) result.matchesExpectedChannel = result.channelId === expected.id;
  return result;
}
