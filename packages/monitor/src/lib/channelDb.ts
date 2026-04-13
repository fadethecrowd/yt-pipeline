/**
 * Channel-scoped data access layer.
 *
 * Every prisma call in monitor source files goes through this module so the
 * CHANNEL env var automatically routes reads/writes to the correct tables:
 *
 *   - `videos` / `topics`        — routes to Video/Topic for ai-doom-scroll,
 *                                   WcVideo/WcTopic for wet-circuit.
 *   - `snapshots` / `comments`  — single tables with a `channel` column;
 *     `actions` / `digestLogs` /  filters and inserts always include the
 *     `goal` / `topicSeeds` /     current channel automatically.
 *     `redditPosts`
 *
 * New monitor code MUST NOT call prisma.video / prisma.topic / prisma.comment
 * / etc. directly — everything goes through this layer.
 */
import { prisma } from "./prisma";
import { env } from "../config";

const ch = () => env().CHANNEL;

// ── Video / Topic routing (pipeline-owned tables) ──────────────────────────
// Returns match Video or WcVideo shapes (they are structurally compatible
// for monitor's needs: both have topic/seoTitle/youtubeId/scheduledAt/etc.).

export const videos = {
  findMany: (args?: any): Promise<any[]> =>
    ch() === "wet-circuit"
      ? (prisma.wcVideo.findMany(args) as any)
      : (prisma.video.findMany(args) as any),

  findUnique: (args: any): Promise<any | null> =>
    ch() === "wet-circuit"
      ? (prisma.wcVideo.findUnique(args) as any)
      : (prisma.video.findUnique(args) as any),

  findUniqueOrThrow: (args: any): Promise<any> =>
    ch() === "wet-circuit"
      ? (prisma.wcVideo.findUniqueOrThrow(args) as any)
      : (prisma.video.findUniqueOrThrow(args) as any),

  update: (args: any): Promise<any> =>
    ch() === "wet-circuit"
      ? (prisma.wcVideo.update(args) as any)
      : (prisma.video.update(args) as any),

  count: (args?: any): Promise<number> =>
    ch() === "wet-circuit"
      ? prisma.wcVideo.count(args)
      : prisma.video.count(args),
};

// ── Channel-scoped monitor tables ──────────────────────────────────────────
// Each method injects `channel: ch()` into where/data automatically.

const withChannelWhere = <T extends { where?: any }>(args?: T): T =>
  ({ ...(args ?? {}), where: { ...(args?.where ?? {}), channel: ch() } }) as T;

export const snapshots = {
  createMany: (args: { data: Array<Record<string, unknown>> }) =>
    prisma.videoSnapshot.createMany({
      data: args.data.map((d) => ({ ...d, channel: ch() })) as any,
    }),

  findFirst: (args?: any) =>
    prisma.videoSnapshot.findFirst(withChannelWhere(args)),

  findMany: (args?: any) =>
    prisma.videoSnapshot.findMany(withChannelWhere(args)),

  groupBy: (args: any) =>
    prisma.videoSnapshot.groupBy(withChannelWhere(args) as any),

  aggregate: (args: any) =>
    prisma.videoSnapshot.aggregate(withChannelWhere(args) as any),
};

export const comments = {
  findMany: (args?: any) =>
    prisma.comment.findMany(withChannelWhere(args)),

  findByYoutubeCommentId: (youtubeCommentId: string) =>
    prisma.comment.findUnique({
      where: {
        channel_youtubeCommentId: { channel: ch(), youtubeCommentId },
      },
    }),

  create: (args: { data: Record<string, unknown> }) =>
    prisma.comment.create({ data: { ...args.data, channel: ch() } as any }),
};

export const actions = {
  findFirst: (args: any) =>
    prisma.monitorAction.findFirst(withChannelWhere(args)),

  findUnique: (args: any) => prisma.monitorAction.findUnique(args),

  create: (args: { data: Record<string, unknown> }) =>
    prisma.monitorAction.create({ data: { ...args.data, channel: ch() } as any }),

  update: (args: any) => prisma.monitorAction.update(args),

  count: (args?: any) =>
    prisma.monitorAction.count(withChannelWhere(args)),
};

export const digestLogs = {
  create: (args: { data: Record<string, unknown> }) =>
    prisma.digestLog.create({ data: { ...args.data, channel: ch() } as any }),

  findFirst: (args?: any) =>
    prisma.digestLog.findFirst(withChannelWhere(args)),
};

export const goal = {
  find: () => prisma.channelGoal.findUnique({ where: { channel: ch() } }),

  upsert: (data: { goal: string; autonomyTier?: number }) =>
    prisma.channelGoal.upsert({
      where: { channel: ch() },
      create: { channel: ch(), ...data },
      update: data,
    }),

  updateAutonomyTier: (autonomyTier: number) =>
    prisma.channelGoal.update({
      where: { channel: ch() },
      data: { autonomyTier },
    }),
};

export const topicSeeds = {
  create: (args: { data: Record<string, unknown> }) =>
    prisma.topicSeed.create({ data: { ...args.data, channel: ch() } as any }),
};

export const redditPosts = {
  findFirst: (args: any) =>
    prisma.redditPost.findFirst(withChannelWhere(args)),

  findMany: (args?: any) =>
    prisma.redditPost.findMany(withChannelWhere(args)),

  create: (args: { data: Record<string, unknown> }) =>
    prisma.redditPost.create({ data: { ...args.data, channel: ch() } as any }),

  update: (args: any) => prisma.redditPost.update(args),
};
