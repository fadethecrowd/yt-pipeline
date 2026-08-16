import { prisma } from "./lib/prisma";
import { youtube } from "./lib/youtube";
import { sendAlert } from "./telegram";
import type { HealthDeps } from "./healthTick";
import type { RunView } from "./lib/videoHealth";

export { startHealthLoop, runHealthTick } from "./healthTick";
export type { HealthDeps, HealthTickResult } from "./healthTick";

/**
 * Production wiring for HEALTH_ONLY.
 *
 * Every query is scoped to the caller's channel: AI Doom reads `video`, Wet
 * Circuit reads `wcVideo`, and neither can see the other's rows because the
 * model is chosen once, here, from the channel key.
 *
 * The YouTube surface is deliberately one call — `videos.list` for status — so
 * the health path holds a client that is only ever asked to read. It never
 * imports the executor, the decision engine, or the AI budget.
 */

const RECENT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a scheduled video stays interesting.
 *
 * Without this the check evaluated every row that ever carried a scheduledAt —
 * months of already-published videos — and reported each as a go-live failure,
 * which is both wrong and the loudest possible first-week noise. A video is
 * relevant while its go-live is imminent or just past; after that its state is
 * history, not an incident. Seven days comfortably covers a Mon/Wed/Fri cadence
 * plus a weekend.
 */
const SCHEDULE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export function realHealthDeps(channel: "ai-doom-scroll" | "wet-circuit"): HealthDeps {
  const model = channel === "ai-doom-scroll" ? "video" : "wcVideo";
  const table = (prisma as unknown as Record<string, {
    findMany(a: unknown): Promise<{ id: string; youtubeId: string | null; status: string; scheduledAt: Date | null }[]>;
    findUnique(a: unknown): Promise<unknown>;
  }>)[model]!;

  return {
    async scheduledVideos() {
      return table.findMany({
        where: { scheduledAt: { gte: new Date(Date.now() - SCHEDULE_LOOKBACK_MS) } },
        select: { id: true, youtubeId: true, status: true, scheduledAt: true },
        orderBy: { scheduledAt: "desc" },
        take: 25,
      });
    },

    async ytView(youtubeId) {
      const res = await youtube().videos.list({ part: ["status"], id: [youtubeId] });
      const item = res.data.items?.[0];
      if (!item) return { exists: false, privacyStatus: null, publishAt: null };
      return {
        exists: true,
        privacyStatus: item.status?.privacyStatus ?? null,
        publishAt: item.status?.publishAt ?? null,
      };
    },

    unresolvedIntentCount: () => prisma.uploadIntent.count({
      where: { NOT: { state: { in: ["PERSISTED", "RECONCILED_HISTORICAL_UPLOAD"] } } },
    }),

    async recentRuns() {
      const runs = await prisma.pipelineRun.findMany({
        where: { channel, startTime: { gte: new Date(Date.now() - RECENT_RUN_WINDOW_MS) } },
        select: { id: true, status: true, startTime: true, endTime: true, videoId: true, youtubeId: true },
        orderBy: { startTime: "desc" },
        take: 20,
      });
      // Gather the durable evidence that lets a terminal FAILED be told apart
      // from an incident. Only for runs that actually failed — a successful run
      // needs none of this, and the queries are not free.
      const reserved = (await prisma.creditBudget.findMany({
        where: { channel, NOT: { testStage: "DIAGNOSTIC" } },
        select: { reservedChars: true },
      })).reduce((a, b) => a + b.reservedChars, 0);

      const out: RunView[] = [];
      for (const r of runs) {
        const base = { id: r.id, status: r.status, startTime: r.startTime, endTime: r.endTime };
        if (r.status !== "FAILED" && r.status !== "CRITICAL") { out.push(base); continue; }
        const video = r.videoId ? await table.findUnique({
          where: { id: r.videoId },
          select: { status: true, youtubeId: true, videoPath: true, scheduledAt: true },
        }) as unknown as {
          status: string; youtubeId: string | null; videoPath: string | null;
          scheduledAt: Date | null;
        } | null : null;
        // Usage is keyed by either the run or the candidate; count both so a
        // row recorded against only one of them still counts as spend.
        const narrationRows = r.videoId
          ? await prisma.elevenLabsUsage.count({
              where: { OR: [{ runId: r.id }, { videoId: r.videoId }] } })
          : await prisma.elevenLabsUsage.count({ where: { runId: r.id } });
        const uploadIntents = r.videoId
          ? await prisma.uploadIntent.count({ where: { videoId: r.videoId } })
          : 0;
        out.push({
          ...base,
          evidence: video ? {
            narrationRows,
            reservedChars: reserved,
            candidateTerminal: video.status === "FAILED",
            hasRenderArtifact: !!video.videoPath,
            uploadIntents,
            youtubeId: video.youtubeId ?? r.youtubeId ?? null,
            scheduledAt: video.scheduledAt ?? null,
          } : undefined,   // no candidate row = unknown = blocking
        });
      }
      return out;
    },

    async budgets() {
      const rows = await prisma.creditBudget.findMany({
        where: { channel, NOT: { testStage: "DIAGNOSTIC" } },
        select: { testStage: true, limitChars: true, reservedChars: true },
      });
      return rows.map((r) => ({
        key: `${channel}/${r.testStage}`, limit: r.limitChars, reserved: r.reservedChars,
      }));
    },

    activeRunCount: () => prisma.pipelineRun.count({ where: { channel, endTime: null } }),

    async pilots() {
      const rows = await (prisma as never as {
        productionPilot: { findMany(a: unknown): Promise<PilotRow[]> };
      }).productionPilot.findMany({
        where: { channel },
        select: {
          pilotId: true, status: true, successCount: true, maxSuccesses: true,
          successVideoIds: true,
        },
      });
      return rows;
    },

    sendAlert: (text) => sendAlert(text),
    now: () => new Date(),
    log: (line) => console.log(line),
  };
}

interface PilotRow {
  pilotId: string; status: string; successCount: number; maxSuccesses: number;
  successVideoIds: string[];
}
