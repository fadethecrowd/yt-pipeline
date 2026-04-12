import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { env } from "./config";

export interface ChannelSpec {
  key: ChannelKey;
  id: string;
  title: string;
}

export const CHANNELS = {
  "wet-circuit": {
    key: "wet-circuit",
    id: "UC9iJDqlrKEs0uuMeIjb9DVA",
    title: "Wet Circuit",
  },
  "ai-doom-scroll": {
    key: "ai-doom-scroll",
    id: "UCSbJfiA1aobp6G_rgwbHPMw",
    title: "AI Doom Scroll",
  },
} as const;

export type ChannelKey = "wet-circuit" | "ai-doom-scroll";

export function buildYouTubeAuth(): OAuth2Client {
  const config = env();
  const auth = new google.auth.OAuth2(
    config.YOUTUBE_CLIENT_ID,
    config.YOUTUBE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: config.YOUTUBE_REFRESH_TOKEN });
  return auth;
}

export async function verifyChannel(
  expected: ChannelSpec,
  serviceLabel: string,
): Promise<void> {
  const auth = buildYouTubeAuth();
  const yt = google.youtube({ version: "v3", auth });
  const res = await yt.channels.list({ part: ["snippet"], mine: true });
  const channel = res.data.items?.[0];

  if (!channel) {
    throw new Error(
      `[${serviceLabel}] YouTube auth verification failed: no channel returned for current refresh token. ` +
        `This service is pinned to "${expected.title}" (${expected.id}).`,
    );
  }

  const actualId = channel.id ?? "";
  const actualTitle = channel.snippet?.title ?? "";

  console.log(
    `[${serviceLabel}] Authenticated YouTube channel: title="${actualTitle}" id=${actualId}`,
  );

  if (actualId !== expected.id || actualTitle !== expected.title) {
    throw new Error(
      `[${serviceLabel}] YouTube channel mismatch — expected title="${expected.title}" id=${expected.id}, ` +
        `but refresh token authenticates as title="${actualTitle}" id=${actualId}. ` +
        `This service is pinned to "${expected.title}" only. Set YOUTUBE_REFRESH_TOKEN on this Railway ` +
        `service to the refresh_token from token-${expected.key}.json.`,
    );
  }

  console.log(
    `[${serviceLabel}] ✓ Channel verified: ${expected.title} (${expected.id})`,
  );
}
