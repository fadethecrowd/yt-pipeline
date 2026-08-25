import { google, youtube_v3, youtubeAnalytics_v2 } from "googleapis";
import { buildYouTubeAuth } from "@yt-pipeline/pipeline-core";

let _client: youtube_v3.Youtube | null = null;
let _analytics: youtubeAnalytics_v2.Youtubeanalytics | null = null;

/**
 * The monitor's credential, from the one builder the whole repo shares.
 *
 * It used to read YOUTUBE_REFRESH_TOKEN straight from the environment while
 * `index.ts` proved the channel through `verifyChannel()` — which resolves via
 * `buildYouTubeAuth()`. Two credentials, one of them verified: the monitor
 * could have reported analytics for a channel other than the one it had just
 * checked. Same builder now, so the identity it verifies is the identity it
 * polls.
 */
function getAuth() {
  return buildYouTubeAuth();
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
