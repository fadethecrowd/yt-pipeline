import "dotenv/config";
import { google } from "googleapis";
import { createServer } from "node:http";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env");
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

console.log("\n🔗 Open this URL in your browser to authorize:\n");
console.log(authUrl);
console.log("\nWaiting for callback on localhost:3000 ...\n");

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("Missing code parameter");
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Done! You can close this tab.</h1>");

    console.log("✅ Tokens received!\n");
    console.log("YOUTUBE_REFRESH_TOKEN=" + tokens.refresh_token);
    console.log("\nAdd this to your .env file.\n");

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500);
    res.end("Token exchange failed");
    console.error("Token exchange error:", err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
