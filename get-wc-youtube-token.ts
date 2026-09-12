/**
 * Mint a YouTube refresh token for the Wet Circuit channel.
 *
 *   npx tsx get-wc-youtube-token.ts
 *
 * A thin wrapper. The flow lives in get-youtube-token.ts and is shared with AI
 * Doom Scroll: a loopback listener on 127.0.0.1, PKCE S256, a random `state`
 * validated on the callback, and a temporary token that is only promoted once
 * the API confirms the channel is Wet Circuit (UC9iJDqlrKEs0uuMeIjb9DVA).
 * Nothing is pasted into the terminal and no secret is ever printed.
 *
 * This file used to be a FORK of that script, and that is the whole reason it
 * exists in this shape now. When ad5a43d moved the real one off Google's
 * retired out-of-band redirect, the fork kept `urn:ietf:wg:oauth:2.0:oob` and
 * quietly rotted: minting Wet Circuit failed with "Error 400: invalid_request"
 * at the consent screen, and would have kept failing however many times the
 * account was re-checked, because the account was never the problem. The fork
 * had also missed the 0600 write, the no-secret-printing rule and the channel
 * verification. Delegating means the next auth change cannot reach only one
 * channel.
 *
 * Run it from the repo root: .env is read from the current directory.
 */
process.env.OAUTH_CHANNEL = "wet-circuit";

// Dynamic, and deliberately not awaited at top level: tsx compiles this to CJS,
// where top-level await is a build error. get-youtube-token.ts runs main() on
// load and reads OAUTH_CHANNEL at module scope, so the assignment above must
// happen first — which a static `import` at the top of the file would not
// guarantee. Only a module-load failure lands here; the flow's own errors are
// handled inside it.
import("./get-youtube-token").catch((err: unknown) => {
  console.error(`\n✗ could not start the OAuth helper: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
