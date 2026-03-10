/**
 * One-time OAuth2 setup script to get a YouTube refresh token.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com
 *   2. Create a project and enable the "YouTube Data API v3"
 *   3. Create OAuth2 credentials (Desktop app type)
 *   4. Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env
 *
 * Usage:
 *   npx tsx get-youtube-token.ts
 *
 * This will:
 *   1. Print a URL — open it in your browser
 *   2. Authorize and copy the code from the redirect
 *   3. Paste the code back here
 *   4. Print the refresh token — add it to .env as YOUTUBE_REFRESH_TOKEN
 */
import "dotenv/config";
import { createInterface } from "node:readline";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

async function main() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first."
    );
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force refresh token generation
  });

  console.log("=== YouTube OAuth2 Setup ===\n");
  console.log("1. Open this URL in your browser:\n");
  console.log(`   ${authUrl}\n`);
  console.log("2. Authorize the application");
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
        "\nNo refresh token returned. Make sure you used prompt: 'consent'."
      );
      console.error(
        "Try revoking access at https://myaccount.google.com/permissions and run again."
      );
      process.exit(1);
    }

    console.log("\n=== Success! ===\n");
    console.log("Add this to your .env file:\n");
    console.log(`YOUTUBE_REFRESH_TOKEN="${tokens.refresh_token}"`);
    console.log(
      "\nAccess token (expires, for reference only):",
      tokens.access_token?.slice(0, 20) + "..."
    );
  } catch (err: any) {
    console.error("\nFailed to exchange code for tokens:", err.message);
    process.exit(1);
  }
}

main();
