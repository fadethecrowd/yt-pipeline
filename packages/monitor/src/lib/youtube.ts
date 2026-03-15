import { google, youtube_v3 } from "googleapis";
import { env } from "../config";

let _client: youtube_v3.Youtube | null = null;

/** OAuth2-authenticated YouTube client used for all API calls. */
export function youtube(): youtube_v3.Youtube {
  if (!_client) {
    const config = env();
    const auth = new google.auth.OAuth2(
      config.YOUTUBE_CLIENT_ID,
      config.YOUTUBE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
    _client = google.youtube({ version: "v3", auth });
  }
  return _client;
}
