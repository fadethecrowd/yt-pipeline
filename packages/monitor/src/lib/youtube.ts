import { google, youtube_v3, youtubeAnalytics_v2 } from "googleapis";
import { env } from "../config";

let _client: youtube_v3.Youtube | null = null;
let _analytics: youtubeAnalytics_v2.Youtubeanalytics | null = null;

function getAuth() {
  const config = env();
  const auth = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  return auth;
}

/** OAuth2-authenticated YouTube Data API client. */
export function youtube(): youtube_v3.Youtube {
  if (!_client) {
    _client = google.youtube({ version: "v3", auth: getAuth() });
  }
  return _client;
}

/** OAuth2-authenticated YouTube Analytics API client. */
export function youtubeAnalytics(): youtubeAnalytics_v2.Youtubeanalytics {
  if (!_analytics) {
    _analytics = google.youtubeAnalytics({ version: "v2", auth: getAuth() });
  }
  return _analytics;
}
