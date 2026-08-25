import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Exactly one place in this repository may construct a YouTube credential.
 *
 * `buildYouTubeAuth()`'s docstring has promised since c7a6a49 (2026-07-30) that
 * every YouTube client is built from it, "so a credential that passes preflight
 * is provably the one the uploader uses". The promise was true only of
 * pipeline-core. Four other live paths — AI Doom's Shorts stage, both Wet
 * Circuit upload stages, and the monitor — each built their own OAuth2 client
 * straight from YOUTUBE_REFRESH_TOKEN.
 *
 * That is not a style problem. AI Doom's Shorts stage called `prepareUpload`,
 * which verifies the channel through `buildYouTubeAuth()`, and then called
 * `videos.insert` on a *different* credential. Since 2026-07-30 the env
 * refresh token has been dead, so every automated Short verified a good channel
 * and then failed the insert — swallowed as a non-fatal FAILED outcome. Zero
 * Shorts shipped between then and 2026-08-25, all by hand.
 *
 * The worse case never fired only by luck: had the env credential been VALID
 * but pointed at the other channel, the guard would have passed on channel A
 * and the video would have landed on channel B. Splitting the credential
 * defeats every channel guard downstream of it, because the guard and the
 * write no longer speak about the same account.
 *
 * So the class is closed structurally: no file may construct an OAuth2 client
 * except the sanctioned builder and the consent-flow helpers that MINT the
 * credential the builder later consumes.
 */

/**
 * The only files permitted to construct an OAuth2 client, and why.
 *
 * A file earns a place here only if it cannot use `buildYouTubeAuth()` by
 * definition — i.e. it is producing the refresh token, not consuming one.
 * "It's only a script" is NOT a reason: scripts/upload-diagnostic.ts uploaded
 * real video to a real channel and had the exact split-credential bug.
 */
const SANCTIONED = new Map<string, string>([
  [
    "packages/pipeline-core/src/youtubeAuth.ts",
    "the single sanctioned builder — this is the one construction site",
  ],
  [
    "get-youtube-token.ts",
    "OAuth consent flow: mints the AI Doom refresh token the builder consumes",
  ],
  [
    "get-wc-youtube-token.ts",
    "OAuth consent flow: mints the Wet Circuit refresh token",
  ],
  [
    "scripts/get-youtube-token.ts",
    "OAuth consent flow (older helper): mints a refresh token",
  ],
]);

/** `new google.auth.OAuth2(...)` or a bare `new OAuth2Client(...)`. */
const CONSTRUCTION = /new\s+(?:google\s*\.\s*auth\s*\.\s*OAuth2|OAuth2Client)\s*\(/;

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("node_modules") && !f.startsWith("dist/")
      && !f.includes("/dist/"));
}

describe("every YouTube credential comes from buildYouTubeAuth", () => {
  test("no file outside the sanctioned builder constructs an OAuth2 client", () => {
    const offenders: string[] = [];
    for (const file of trackedSources()) {
      if (SANCTIONED.has(file)) continue;
      // This test names the pattern it forbids, so exempt itself by identity.
      if (file === "tests/youtube-credential-singularity.test.ts") continue;
      const body = readFileSync(file, "utf8");
      if (CONSTRUCTION.test(body)) offenders.push(file);
    }
    assert.deepEqual(
      offenders, [],
      `these files build their own YouTube credential instead of calling `
      + `buildYouTubeAuth()/buildYouTubeClient() from @yt-pipeline/pipeline-core:\n`
      + offenders.map((f) => `  - ${f}`).join("\n"),
    );
  });

  test("every sanctioned exemption still exists and is still a minting path", () => {
    const tracked = new Set(trackedSources());
    for (const [file, why] of SANCTIONED) {
      assert.ok(tracked.has(file), `${file} is exempted but no longer tracked — drop the exemption`);
      const body = readFileSync(file, "utf8");
      assert.ok(CONSTRUCTION.test(body), `${file} no longer constructs a client — drop the exemption (${why})`);
    }
    // The consent helpers must actually be consent helpers: each one asks
    // Google for offline access. A file that merely refreshes a token has no
    // business here.
    for (const file of [...SANCTIONED.keys()].filter((f) => f !== "packages/pipeline-core/src/youtubeAuth.ts")) {
      assert.match(readFileSync(file, "utf8"), /generateAuthUrl|access_type/,
        `${file} is exempted as an OAuth consent flow but performs none`);
    }
  });
});

describe("the upload paths verify and write on one credential", () => {
  /** Stages that both verify a channel and then write to YouTube. */
  const UPLOAD_STAGES = [
    "src/stages/shortsGenerator.ts",
    "packages/wc-pipeline/src/stages/shortsGenerator.ts",
    "packages/wc-pipeline/src/stages/youtubeUpload.ts",
    "packages/pipeline-core/src/stages/youtubeUpload.ts",
    "packages/monitor/src/lib/youtube.ts",
  ];

  for (const file of UPLOAD_STAGES) {
    test(`${file} takes its client from pipeline-core`, () => {
      const body = readFileSync(file, "utf8");
      assert.doesNotMatch(body, CONSTRUCTION);
      assert.doesNotMatch(body, /function\s+getYouTubeClient\b/,
        "a local getYouTubeClient() is how the credential split happened");
      assert.match(body, /buildYouTubeClient|buildYouTubeAuth/);
    });
  }

  test("the AI Doom Shorts stage verifies and inserts on the same client", () => {
    const body = readFileSync("src/stages/shortsGenerator.ts", "utf8");
    // prepareUpload verifies the channel via buildYouTubeAuth; the insert must
    // come from the same builder or the verification proves nothing.
    assert.ok(body.indexOf("prepareUpload(") < body.indexOf("videos.insert"));
    assert.match(body, /buildYouTubeClient\(\)/);
  });
});
