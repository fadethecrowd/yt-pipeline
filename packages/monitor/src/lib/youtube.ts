import { google, youtube_v3 } from "googleapis";
import { env } from "../config";

let _readOnly: youtube_v3.Youtube | null = null;
let _authenticated: youtube_v3.Youtube | null = null;

/** Public-data client (API key auth, read-only). */
export function youtubeReadOnly(): youtube_v3.Youtube {
  if (!_readOnly) {
    const config = env();
    _readOnly = google.youtube({
      version: "v3",
      auth: config.YOUTUBE_API_KEY,
    });
  }
  return _readOnly;
}

/** OAuth2-authenticated client (can modify channel data). */
export function youtubeAuth(): youtube_v3.Youtube {
  if (!_authenticated) {
    const config = env();
    const auth = new google.auth.OAuth2(
      config.YOUTUBE_CLIENT_ID,
      config.YOUTUBE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
    _authenticated = google.youtube({ version: "v3", auth });
  }
  return _authenticated;
}
