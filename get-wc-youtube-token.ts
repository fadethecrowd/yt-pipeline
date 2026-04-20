/**
 * One-time OAuth2 setup script to get a YouTube refresh token for the
 * Wet Circuit channel (separate Google account from AI Doom Scroll).
 *
 * Prerequisites:
 *   1. In Google Cloud Console, have an OAuth2 Desktop-app client with
 *      "YouTube Data API v3" enabled.
 *   2. Set WC_YOUTUBE_CLIENT_ID and WC_YOUTUBE_CLIENT_SECRET in .env
 *      (falls back to YOUTUBE_CLIENT_ID/SECRET if the same OAuth client
 *      is reused — the Google account you log in with is what determines
 *      which channel the refresh token is bound to).
 *
 * Usage:
 *   npx tsx get-wc-youtube-token.ts
 *
 * Steps:
 *   1. Open the printed URL in a browser where you're signed in as the
 *      Wet Circuit Google account (or use an incognito window and sign
 *      in fresh). If you have multiple Google accounts, pick the Wet
 *      Circuit one on the account chooser screen.
 *   2. Authorize the requested YouTube scopes.
 *   3. Copy the authorization code shown on the final page.
 *   4. Paste it back into this prompt.
 *   5. Copy the printed refresh token into Railway as
 *      YOUTUBE_REFRESH_TOKEN on the wc-pipeline service.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { google } from "googleapis";

const TOKEN_FILE = "token-wet-circuit.json";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

async function main() {
  const clientId =
    process.env.WC_YOUTUBE_CLIENT_ID ?? process.env.YOUTUBE_CLIENT_ID;
  const clientSecret =
    process.env.WC_YOUTUBE_CLIENT_SECRET ?? process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Set WC_YOUTUBE_CLIENT_ID and WC_YOUTUBE_CLIENT_SECRET (or YOUTUBE_CLIENT_ID/SECRET) in .env first."
    );
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("=== Wet Circuit YouTube OAuth2 Setup ===\n");
  console.log(
    "IMPORTANT: sign in as the Wet Circuit Google account in your browser before authorizing.\n"
  );
  console.log("1. Open this URL in your browser:\n");
  console.log(`   ${authUrl}\n`);
  console.log("2. Choose the Wet Circuit account and authorize");
  console.log("3. Copy the authorization code and paste it below\n");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question("Authorization code: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  try {
    const { tokens } = await auth.getToken(code);

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh token returned. Revoke prior access at https://myaccount.google.com/permissions (while signed in as the Wet Circuit account) and run again."
      );
      process.exit(1);
    }

    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));

    console.log("\n=== Success! ===\n");
    console.log(`Credentials saved to ${TOKEN_FILE}`);
    console.log(
      "\nPaste this into Railway as YOUTUBE_REFRESH_TOKEN on the wc-pipeline service:\n"
    );
    console.log(tokens.refresh_token);

    auth.setCredentials(tokens);
    const yt = google.youtube({ version: "v3", auth });
    const res = await yt.channels.list({ part: ["snippet"], mine: true });
    const channel = res.data.items?.[0];
    if (!channel) {
      console.error("\nNo channel returned for this token.");
      process.exit(1);
    }
    console.log("\n=== Authenticated YouTube Channel ===");
    console.log(`Title: ${channel.snippet?.title}`);
    console.log(`ID:    ${channel.id}`);
  } catch (err: any) {
    console.error("\nFailed to exchange code for tokens:", err.message);
    process.exit(1);
  }
}

main();
