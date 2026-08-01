/**
 * One-time OAuth2 setup script to get a YouTube refresh token for the
 * AI Doom Scroll channel.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com
 *   2. Create a project and enable the "YouTube Data API v3"
 *   3. Create OAuth2 credentials (Desktop app type)
 *   4. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env
 *
 * Usage:
 *   npx tsx get-youtube-token.ts
 *   OAUTH_PORT=53690 npx tsx get-youtube-token.ts   # if the default port is busy
 *
 * Flow:
 *   1. A temporary HTTP listener starts on 127.0.0.1.
 *   2. The Google authorization URL is opened (and printed as a fallback).
 *   3. You sign in and consent in the browser.
 *   4. Google redirects back to the local listener, which captures the code.
 *   5. The code is exchanged for tokens and the listener shuts down.
 *
 * Nothing is pasted into the terminal, and no secret is ever printed.
 *
 * Google retired the out-of-band flow (redirect_uri=urn:ietf:wg:oauth:2.0:oob),
 * which now fails with "Error 400: invalid_request". This script uses the
 * supported loopback redirect instead. If your OAuth client is a "Web
 * application" rather than a "Desktop app", add the exact redirect URI this
 * script prints to the client's Authorized redirect URIs in Cloud Console.
 *
 * SAFETY: the newly issued credentials are written to a TEMPORARY file and
 * used to resolve the authenticated channel BEFORE the real token file is
 * touched. If the identity is not AI Doom Scroll, the temporary file is
 * deleted and the existing token is left exactly as it was.
 */
import "dotenv/config";
import { chmodSync, copyFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { CodeChallengeMethod } from "google-auth-library";
import type { Credentials } from "google-auth-library";

const TOKEN_FILE = "token-ai-doom-scroll.json";
const TEMP_TOKEN_FILE = ".token-ai-doom-scroll.verify.json";

/** The identity this token MUST resolve to. Mirrors youtubeAuth.ts CHANNELS. */
const EXPECTED_CHANNEL_ID = "UCSbJfiA1aobp6G_rgwbHPMw";
const EXPECTED_CHANNEL_TITLE = "AI Doom Scroll";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

/** Loopback ports tried in order. Override with OAUTH_PORT. */
const PORT_CANDIDATES: number[] = process.env.OAUTH_PORT
  ? [Number(process.env.OAUTH_PORT)]
  : [53682, 53683, 53684];

const CALLBACK_PATH = "/oauth2callback";
const CALLBACK_TIMEOUT_MS = Number(process.env.OAUTH_TIMEOUT_MS ?? 5 * 60 * 1000);

/** Files holding credentials are owner-only. */
const SECRET_MODE = 0o600;

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Bind the loopback listener, trying each candidate port in turn. */
async function listenOnLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number; closeServer: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const errors: string[] = [];

  for (const port of PORT_CANDIDATES) {
    const server = createServer(handler);
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });

    const bound = await new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        errors.push(
          err.code === "EADDRINUSE"
            ? `port ${port} already in use`
            : `port ${port}: ${err.code ?? err.message}`,
        );
        server.removeListener("error", onError);
        server.close(() => resolve(false));
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });

    if (!bound) continue;

    // Destroying live sockets matters: a browser keep-alive connection will
    // otherwise hold the process open long after the flow has finished.
    const closeServer = () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      });

    return { server, port, closeServer };
  }

  fail(
    `could not start the local OAuth listener.\n    ${errors.join("\n    ")}\n\n` +
      `  Free one of these ports, or choose another:\n` +
      `      OAUTH_PORT=53690 npx tsx get-youtube-token.ts`,
  );
}

/** Best-effort browser launch. Never fatal — the URL is always printed too. */
function openBrowser(url: string): void {
  if (process.argv.includes("--no-browser") || process.env.OAUTH_NO_BROWSER === "1") return;
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* printed below regardless */
  }
}

function page(title: string, body: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;text-align:center">` +
    `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`
  );
}

interface CallbackResult {
  code: string;
}

/**
 * Serve the loopback callback exactly once and resolve with the code.
 *
 * Rejects on user denial, a missing code, or a state mismatch. The raw query
 * string is never logged.
 */
function awaitCallback(
  expectedState: string,
  register: (h: (req: IncomingMessage, res: ServerResponse) => void) => void,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `timed out after ${CALLBACK_TIMEOUT_MS / 1000}s waiting for the browser callback`,
          ),
        ),
      );
    }, CALLBACK_TIMEOUT_MS);
    timer.unref?.();

    register((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const reply = (status: number, title: string, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(page(title, body));
      };

      if (error) {
        // access_denied is the normal "user clicked Cancel" case.
        reply(400, "Authorization cancelled", "You can close this tab and re-run the command.");
        clearTimeout(timer);
        finish(() =>
          reject(
            new Error(
              error === "access_denied"
                ? "authorization was denied in the browser"
                : `authorization failed: ${error}`,
            ),
          ),
        );
        return;
      }

      if (!state || state !== expectedState) {
        reply(400, "State mismatch", "This callback did not match the request. Nothing was saved.");
        clearTimeout(timer);
        finish(() =>
          reject(new Error("state parameter did not match — possible cross-site request, aborting")),
        );
        return;
      }

      if (!code) {
        reply(400, "No authorization code", "Google did not return a code. Nothing was saved.");
        clearTimeout(timer);
        finish(() => reject(new Error("callback contained no authorization code")));
        return;
      }

      reply(
        200,
        "Authorized",
        "This window can be closed. Verification is continuing in your terminal.",
      );
      clearTimeout(timer);
      finish(() => resolve({ code }));
    });
  });
}

async function main() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    fail("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first.");
  }

  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(503).end();
  };
  const { port, closeServer } = await listenOnLoopback((req, res) => handler(req, res));

  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // PKCE + an unguessable state: both required for a safe public-client
  // loopback flow, since anything on the machine can reach 127.0.0.1.
  const state = randomBytes(24).toString("base64url");
  const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",   // ask for a durable refresh token
    prompt: "consent",        // force a fresh refresh token to be issued
    include_granted_scopes: false,
    scope: SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  console.log("=== YouTube OAuth2 Setup — AI Doom Scroll ===\n");
  console.log(`  listening on : ${redirectUri}`);
  console.log(`  expected     : ${EXPECTED_CHANNEL_TITLE} (${EXPECTED_CHANNEL_ID})\n`);
  console.log("  In the browser:");
  console.log("    • sign in as the PARENT Google account for this channel");
  console.log("    • on the account/brand chooser, pick the Brand Account identity");
  console.log("      that owns AI Doom Scroll — not a personal Gmail identity");
  console.log("    • the account shown by default is NOT proof of the right channel;");
  console.log("      this script verifies the channel ID via the API afterwards\n");
  console.log("  Opening your browser. If it does not open, paste this URL:\n");
  console.log(`   ${authUrl}\n`);
  console.log(`  Waiting for the callback (up to ${CALLBACK_TIMEOUT_MS / 60000} minutes)…`);

  openBrowser(authUrl);

  let tokens: Credentials;
  try {
    const { code } = await awaitCallback(state, (h) => { handler = h; });
    try {
      const exchanged = await auth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
      tokens = exchanged.tokens;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `token exchange failed: ${msg}\n\n` +
          `  If Google reports redirect_uri_mismatch, add this exact URI to the OAuth\n` +
          `  client's Authorized redirect URIs in Cloud Console:\n      ${redirectUri}`,
      );
    }
  } finally {
    // Always tear the listener down, on success or failure.
    await closeServer();
  }

  if (!tokens.refresh_token) {
    fail(
      "no refresh token was returned.\n" +
        "    Revoke this app at https://myaccount.google.com/permissions and re-run.",
    );
  }

  // ── Write to a TEMPORARY file and verify identity before touching the real one ──
  writeFileSync(TEMP_TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: SECRET_MODE });
  chmodSync(TEMP_TOKEN_FILE, SECRET_MODE);

  const discardTemp = () => {
    try { rmSync(TEMP_TOKEN_FILE, { force: true }); } catch { /* nothing to clean */ }
  };

  let channelId: string;
  let channelTitle: string;
  try {
    const verifyAuth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    verifyAuth.setCredentials(tokens);
    const yt = google.youtube({ version: "v3", auth: verifyAuth });
    const res = await yt.channels.list({ part: ["snippet"], mine: true });
    const channel = res.data.items?.[0];
    if (!channel?.id) {
      discardTemp();
      fail(
        "the new credentials resolve to no YouTube channel.\n" +
          "    The existing token file was NOT modified.",
      );
    }
    channelId = channel.id;
    channelTitle = (channel.snippet?.title ?? "").trim();
  } catch (err) {
    discardTemp();
    const msg = err instanceof Error ? err.message : String(err);
    fail(`channel lookup failed: ${msg}\n    The existing token file was NOT modified.`);
  }

  if (channelId !== EXPECTED_CHANNEL_ID) {
    discardTemp();
    console.error("\n✗ CHANNEL IDENTITY MISMATCH — the existing token file was NOT modified.\n");
    console.error(`  Authorized as : ${channelTitle} (${channelId})`);
    console.error(`  Required      : ${EXPECTED_CHANNEL_TITLE} (${EXPECTED_CHANNEL_ID})\n`);
    console.error("  Re-run and choose the Brand Account identity that owns AI Doom Scroll.\n");
    process.exit(2);
  }

  // ── Verified. Back up the previous token, then install the new one. ──
  let backupName: string | null = null;
  if (existsSync(TOKEN_FILE)) {
    backupName = `${TOKEN_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(TOKEN_FILE, backupName);
    chmodSync(backupName, SECRET_MODE);
  }

  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: SECRET_MODE });
  chmodSync(TOKEN_FILE, SECRET_MODE);
  discardTemp();

  console.log("\n=== Verified ===\n");
  console.log(`  channel name    : ${channelTitle}`);
  console.log(`  channel ID      : ${channelId}`);
  console.log(`  token file      : ${TOKEN_FILE}`);
  console.log(`  refresh token   : ${tokens.refresh_token ? "received" : "NOT received"}`);
  if (backupName) console.log(`  previous token  : backed up to ${backupName}`);
  console.log(
    "\n  The refresh token was not printed. Copy it into .env / Railway straight\n" +
      `  from ${TOKEN_FILE} when you need it.\n`,
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
});
