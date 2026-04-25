import TelegramBot from "node-telegram-bot-api";
import { env } from "./config";
import {
  videos,
  snapshots,
  actions,
  goal as goalDb,
} from "./lib/channelDb";
import { prisma } from "./lib/prisma";
import { ActionStatus } from "./lib/types";
import { liveVideoWhere } from "./lib/queries";
import { youtube } from "./lib/youtube";
import type { Decision } from "./lib/types";

let bot: TelegramBot | null = null;

// Track last tick time for /status command
let lastTickTime: Date | null = null;

export function setLastTickTime(time: Date): void {
  lastTickTime = time;
}

/**
 * Send a plain-text message via the Telegram Bot API.
 *
 * Plain text only — no Markdown / MarkdownV2 / HTML parse mode. Legacy
 * Markdown was silently dropping draft messages whose payload contained
 * unbalanced underscores (common in YouTube video IDs like "H_zamD9ofzc").
 * Failures propagate to the caller — silent-swallow was the amplifying
 * defect that caused COMMUNITY_POST actions to land as EXECUTED while
 * the underlying draft send had already been rejected by Telegram.
 */
export async function sendTelegram(text: string): Promise<void> {
  const config = env();

  if (bot) {
    try {
      await bot.sendMessage(config.TELEGRAM_CHAT_ID, text);
    } catch (err) {
      console.error("[telegram] Send failed:", err instanceof Error ? err.message : err);
      throw err;
    }
    return;
  }

  // Fallback to raw fetch if bot not initialized
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] API error ${res.status}: ${body}`);
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

/**
 * Send an alert message. Errors propagate to the caller — previously
 * silently caught, which allowed failed action-router handlers to
 * return success and mark MonitorActions as EXECUTED even when the
 * user-facing draft message had never been delivered.
 */
export async function sendAlert(message: string): Promise<void> {
  await sendTelegram(`⚠️ Alert\n${message}`);
  console.log(`[telegram] Alert sent: ${message}`);
}

// Track pending title selections: messageId -> { actionId, videoId, titles }
const pendingTitleSelections = new Map<number, {
  actionId: string;
  videoId: string;
  titles: [string, string, string];
}>();

/**
 * Send an approval request with inline buttons.
 * UPDATE_TITLE shows all 3 title variants with scores and accepts reply overrides.
 */
export async function sendApprovalRequest(actionId: string, decision: Decision): Promise<void> {
  const config = env();
  if (!bot) {
    console.error("[telegram] Cannot send approval request — bot not initialized");
    return;
  }

  // Special handling for UPDATE_TITLE with title variants
  if (decision.type === "UPDATE_TITLE" && decision.payload.titleVariantB) {
    const t1 = (decision.payload.newTitle as string) ?? "N/A";
    const t2 = (decision.payload.titleVariantB as string) ?? "N/A";
    const t3 = (decision.payload.titleVariantC as string) ?? "N/A";
    const score = decision.payload.primaryScore as number | undefined;

    const lines = [
      "Title Selection — auto-picked #1",
      "",
      `Video: ${decision.videoId}`,
      "",
      `1. [auto] "${t1}"${score ? ` (score: ${score}/40)` : ""}`,
      `2. "${t2}"`,
      `3. [wildcard] "${t3}"`,
      "",
      "Reply 1, 2, or 3 to override. Any other reply confirms auto-pick.",
    ];

    try {
      const sent = await bot.sendMessage(config.TELEGRAM_CHAT_ID, lines.join("\n"), {
        reply_markup: {
          inline_keyboard: [[
            { text: "\u2705 Approve", callback_data: `approve:${actionId}` },
            { text: "\u274C Reject", callback_data: `reject:${actionId}` },
          ]],
        },
      });
      pendingTitleSelections.set(sent.message_id, {
        actionId,
        videoId: decision.videoId,
        titles: [t1, t2, t3],
      });
      console.log(`[telegram] Title selection sent for action ${actionId} (msg ${sent.message_id})`);
      return;
    } catch (err) {
      console.error("[telegram] Failed to send title selection:", err instanceof Error ? err.message : err);
    }
  }

  // Default approval request for other action types
  const lines = [
    "Action Requires Approval",
    "",
    `Type: ${decision.type}`,
    `Video: ${decision.videoId}`,
    `Reason: ${decision.reason}`,
  ];

  if (decision.type === "UPDATE_TITLE" && decision.payload.newTitle) {
    lines.push(`Proposed title: ${decision.payload.newTitle}`);
  }

  if (decision.type === "UPDATE_TAGS" && Array.isArray(decision.payload.tags)) {
    lines.push(`Tags: ${(decision.payload.tags as string[]).join(", ")}`);
  }

  if (decision.type === "UPDATE_DESCRIPTION" && decision.payload.newDescription) {
    const desc = (decision.payload.newDescription as string).slice(0, 500);
    lines.push(`\nProposed description (preview):\n${desc}...`);
  }

  if (decision.type === "REPLY_COMMENT") {
    if (decision.payload.commentText) {
      lines.push(`\nOriginal comment: "${decision.payload.commentText}"`);
    }
    if (decision.payload.replyText) {
      lines.push(`Drafted reply: "${decision.payload.replyText}"`);
    }
  }

  if ((decision.type === "COMMUNITY_POST" || decision.type === "REPROMOTE") && decision.payload.draftText) {
    lines.push(`\nDraft:\n${decision.payload.draftText}`);
  }

  if (decision.type === "REDDIT_POST") {
    lines.push(`\nSubreddit: r/${decision.payload.subreddit}`);
    lines.push(`Title: ${decision.payload.postTitle}`);
    lines.push(`\nBody:\n${decision.payload.postBody}`);
  }

  try {
    await bot.sendMessage(config.TELEGRAM_CHAT_ID, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [[
          { text: "\u2705 Approve", callback_data: `approve:${actionId}` },
          { text: "\u274C Reject", callback_data: `reject:${actionId}` },
        ]],
      },
    });
    console.log(`[telegram] Approval request sent for action ${actionId} (${decision.type})`);
  } catch (err) {
    console.error("[telegram] Failed to send approval request:", err instanceof Error ? err.message : err);
    try {
      await bot.sendMessage(config.TELEGRAM_CHAT_ID, `[APPROVAL NEEDED] ${decision.type} for video ${decision.videoId}\n${decision.reason}\n\nAction ID: ${actionId}`);
      console.log(`[telegram] Approval request sent as plain text fallback for action ${actionId}`);
    } catch (retryErr) {
      console.error("[telegram] Fallback send also failed:", retryErr instanceof Error ? retryErr.message : retryErr);
    }
  }
}

/**
 * Send 3 thumbnail variants as photos to Telegram.
 */
export async function sendThumbnailVariants(
  variants: { a: Buffer; b: Buffer; c: Buffer },
  videoTitle: string,
  youtubeId: string,
): Promise<void> {
  const config = env();
  if (!bot) return;

  const caption = [
    `New thumbnails generated — "${videoTitle}"`,
    "",
    "A = Terminal (text only)",
    "B = Frame + strip (uploaded to YouTube)",
    "C = Frame + big text",
    "",
    `Video: https://youtu.be/${youtubeId}`,
  ].join("\n");

  try {
    const labels = ["A", "B", "C"] as const;
    const buffers = [variants.a, variants.b, variants.c];
    // Send as individual photos since sendMediaGroup with buffers is tricky
    for (let i = 0; i < buffers.length; i++) {
      await bot.sendPhoto(config.TELEGRAM_CHAT_ID, buffers[i], {
        caption: i === 0 ? caption : `Variant ${labels[i]}`,
      });
    }
    console.log(`[telegram] Sent 3 thumbnail variants`);
  } catch (err) {
    console.error("[telegram] Failed to send thumbnail variants:", err instanceof Error ? err.message : err);
  }
}

// ── Bot command handlers ────────────────────────────────────────────────

async function handleStart(msg: TelegramBot.Message): Promise<void> {
  const text = [
    "🤖 *YT Pipeline Monitor Bot*",
    "",
    "Available commands:",
    "/start — Show this message",
    "/status — Monitor status (last tick, videos, decisions)",
    "/goal <text> — Set channel goal",
    "/goal — Show current goal",
    "/tier 2|3 — Set autonomy tier",
  ].join("\n");

  await bot!.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
}

/**
 * Escape characters reserved in Telegram MarkdownV2 so dynamic strings
 * (timestamps with dots/dashes, IDs/stage names with underscores, error
 * text with parens, etc.) cannot break message parsing. Per Telegram docs
 * https://core.telegram.org/bots/api#markdownv2-style — required set:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function handleStatus(msg: TelegramBot.Message): Promise<void> {
  try {
    const config = env();
    const E = escapeTelegramMarkdown;

    // DB-side count of real (non-dryrun) uploaded videos.
    const dbRows = await videos.findMany({
      where: { ...liveVideoWhere },
      select: { youtubeId: true },
    });
    const uploadedInDb = dbRows.length;

    // Live-visibility classification: ask YouTube for privacyStatus on
    // each row's youtubeId. A video returned with privacyStatus="public"
    // is live; a video returned private/unlisted is in the DB but not
    // publicly visible; a youtubeId missing from the response is
    // "stale/unfindable" — most often deleted from YouTube after upload.
    let livePublic = 0;
    let stale = 0;
    let liveProbeError: string | null = null;

    const ytIds = dbRows.map((r) => r.youtubeId!).filter(Boolean);
    if (ytIds.length > 0) {
      try {
        const yt = youtube();
        const returned = new Set<string>();
        const publicIds = new Set<string>();
        // Batch in groups of 50 (Data API limit per call).
        for (let i = 0; i < ytIds.length; i += 50) {
          const batch = ytIds.slice(i, i + 50);
          const res = await yt.videos.list({ part: ["status"], id: batch });
          for (const item of res.data.items ?? []) {
            if (!item.id) continue;
            returned.add(item.id);
            if (item.status?.privacyStatus === "public") publicIds.add(item.id);
          }
        }
        livePublic = publicIds.size;
        stale = ytIds.length - returned.size;
      } catch (err) {
        liveProbeError = err instanceof Error ? err.message : String(err);
      }
    }

    const recentDecisions = await actions.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    const lastSnapshot = await snapshots.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    // Static parens / dots / dashes pre-escaped for MarkdownV2.
    // Dynamic values are wrapped through E() at interpolation time.
    const videoLines = liveProbeError
      ? [
          `Videos \\(uploaded in DB\\): ${uploadedInDb}`,
          `Videos \\(live on YouTube\\): probe failed — ${E(liveProbeError.slice(0, 80))}`,
        ]
      : [
          `Videos \\(live on YouTube\\): ${livePublic}`,
          `Videos \\(uploaded in DB\\): ${uploadedInDb}`,
          `Videos \\(stale/unfindable\\): ${stale}`,
        ];

    // Latest PipelineRun for this channel (written by the pipelines, read here).
    // errorMessage intentionally not included — may contain Markdown-trap chars.
    const lastRun = await prisma.pipelineRun.findFirst({
      where: { channel: config.CHANNEL },
      orderBy: { createdAt: "desc" },
    });
    const runLines = !lastRun
      ? ["", "Last pipeline run: \\(none recorded\\)"]
      : (() => {
          const warnCount = Array.isArray(lastRun.warnings)
            ? (lastRun.warnings as unknown[]).length
            : 0;
          const dur =
            lastRun.durationMs !== null && lastRun.durationMs !== undefined
              ? `${(lastRun.durationMs / 1000).toFixed(1)}s`
              : "n/a";
          const items = [
            "",
            `Last pipeline run: ${E(lastRun.status)} \\(${E(lastRun.runMode)}\\)`,
            `  started:  ${E(lastRun.startTime.toISOString())}`,
            `  duration: ${E(dur)}`,
          ];
          if (lastRun.failedStage) items.push(`  failedStage: ${E(lastRun.failedStage)}`);
          if (warnCount > 0) items.push(`  warnings: ${warnCount}`);
          return items;
        })();

    const lines = [
      "📊 *Monitor Status*",
      "",
      `Channel: ${E(config.CHANNEL)}`,
      `Last tick: ${E(lastTickTime ? lastTickTime.toISOString() : "not yet")}`,
      `Last snapshot: ${E(lastSnapshot ? lastSnapshot.createdAt.toISOString() : "none")}`,
      ...videoLines,
      `Decisions \\(24h\\): ${recentDecisions}`,
      ...runLines,
    ];

    await bot!.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "MarkdownV2" });
  } catch (err) {
    console.error("[telegram] /status failed:", err instanceof Error ? err.message : err);
    await bot!.sendMessage(msg.chat.id, "Failed to fetch status.");
  }
}

async function handleGoal(msg: TelegramBot.Message): Promise<void> {
  const text = msg.text ?? "";
  const args = text.replace(/^\/goal\s*/, "").trim();
  const config = env();

  try {
    if (!args) {
      // Show current goal (this channel only)
      const goal = await goalDb.find();
      if (!goal) {
        await bot!.sendMessage(
          msg.chat.id,
          `No goal set for *${config.CHANNEL}*. Use \`/goal <text>\` to set one.`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot!.sendMessage(
          msg.chat.id,
          `🎯 *Current Goal* (${config.CHANNEL})\n${goal.goal}\n\nAutonomy tier: ${goal.autonomyTier}`,
          { parse_mode: "Markdown" },
        );
      }
      return;
    }

    // Upsert goal for this channel
    await goalDb.upsert({ goal: args });

    await bot!.sendMessage(msg.chat.id, `✅ Goal saved for *${config.CHANNEL}*: ${args}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[telegram] /goal failed:", err instanceof Error ? err.message : err);
    await bot!.sendMessage(msg.chat.id, "Failed to save goal.");
  }
}

async function handleTier(msg: TelegramBot.Message): Promise<void> {
  const text = msg.text ?? "";
  const tierStr = text.replace(/^\/tier\s*/, "").trim();
  const tier = parseInt(tierStr, 10);

  if (tier !== 2 && tier !== 3) {
    await bot!.sendMessage(msg.chat.id, "Usage: `/tier 2` or `/tier 3`", { parse_mode: "Markdown" });
    return;
  }

  try {
    const existing = await goalDb.find();

    if (!existing) {
      await bot!.sendMessage(msg.chat.id, "Set a goal first with `/goal <text>`", { parse_mode: "Markdown" });
      return;
    }

    await goalDb.updateAutonomyTier(tier);

    await bot!.sendMessage(msg.chat.id, `✅ Autonomy tier set to ${tier}`);
  } catch (err) {
    console.error("[telegram] /tier failed:", err instanceof Error ? err.message : err);
    await bot!.sendMessage(msg.chat.id, "Failed to update tier.");
  }
}

// ── Approval callback handler ────────────────────────────────────────────

async function handleApprovalCallback(query: TelegramBot.CallbackQuery): Promise<void> {
  const data = query.data;
  if (!data) return;

  const [verb, actionId] = data.split(":");
  if (!actionId || (verb !== "approve" && verb !== "reject")) return;

  const monitorAction = await actions.findUnique({
    where: { id: actionId },
  });

  if (!monitorAction) {
    await bot!.answerCallbackQuery(query.id, { text: "Action not found" });
    return;
  }

  if (monitorAction.status !== "AWAITING_APPROVAL") {
    await bot!.answerCallbackQuery(query.id, { text: `Already ${monitorAction.status.toLowerCase()}` });
    return;
  }

  if (verb === "approve") {
    const decision: Decision = {
      videoId: monitorAction.videoId,
      type: monitorAction.type as any,
      payload: (monitorAction.payload as Record<string, unknown>) ?? {},
      reason: monitorAction.reason,
    };

    // Lazy import to break circular dependency: executor -> telegram -> actionRouter -> executor
    const { routeAction } = await import("./actionRouter");
    const result = await routeAction(decision);

    await actions.update({
      where: { id: actionId },
      data: {
        status: result.success ? ActionStatus.EXECUTED : ActionStatus.FAILED,
        result: result.message,
        executedAt: new Date(),
      },
    });

    const emoji = result.success ? "\u2705" : "\u274C";
    await bot!.editMessageText(
      `${emoji} ${monitorAction.type} — ${result.success ? "Approved & executed" : "Approved but execution failed"}\n${result.message}`,
      {
        chat_id: query.message!.chat.id,
        message_id: query.message!.message_id,
      },
    );
    await bot!.answerCallbackQuery(query.id, { text: result.success ? "Executed!" : "Execution failed" });
    console.log(`[telegram] Action ${actionId} approved → ${result.success ? "EXECUTED" : "FAILED"}: ${result.message}`);
  } else {
    await actions.update({
      where: { id: actionId },
      data: { status: ActionStatus.SKIPPED, result: "Rejected by user" },
    });

    await bot!.editMessageText(
      `\u274C ${monitorAction.type} — Rejected\nVideo: ${monitorAction.videoId}`,
      {
        chat_id: query.message!.chat.id,
        message_id: query.message!.message_id,
      },
    );
    await bot!.answerCallbackQuery(query.id, { text: "Rejected" });
    console.log(`[telegram] Action ${actionId} rejected by user`);
  }
}

// ── Title override handler ───────────────────────────────────────────────

async function handleTitleOverride(
  actionId: string,
  videoId: string,
  selectedTitle: string,
  choiceNum: number,
  chatId: number,
): Promise<void> {
  // Update the video's seoTitle to the selected variant
  await videos.update({
    where: { id: videoId },
    data: { seoTitle: selectedTitle },
  });

  // Update the MonitorAction payload to reflect the override
  await actions.update({
    where: { id: actionId },
    data: {
      result: `User selected title #${choiceNum}: "${selectedTitle}"`,
    },
  });

  await bot!.sendMessage(chatId, `Title updated to #${choiceNum}: "${selectedTitle}"`);
  console.log(`[telegram] Title override: action=${actionId} choice=${choiceNum} title="${selectedTitle}"`);
}

// ── Bot initialization ──────────────────────────────────────────────────

let restarting = false;

function registerHandlers(): void {
  if (!bot) return;

  // Log every incoming message with chat ID (helps discover TELEGRAM_CHAT_ID)
  bot.on("message", (msg) => {
    console.log(
      `[telegram] Incoming message: chat_id=${msg.chat.id} from=${msg.from?.username ?? msg.from?.id ?? "unknown"} text="${msg.text ?? ""}"`,
    );

    // Handle title selection override replies (1, 2, or 3)
    if (msg.reply_to_message && msg.text && /^[123]$/.test(msg.text.trim())) {
      const replyToId = msg.reply_to_message.message_id;
      const pending = pendingTitleSelections.get(replyToId);
      if (pending) {
        const choice = parseInt(msg.text.trim(), 10) - 1; // 0-indexed
        const selectedTitle = pending.titles[choice];
        handleTitleOverride(pending.actionId, pending.videoId, selectedTitle, choice + 1, msg.chat.id)
          .then(() => pendingTitleSelections.delete(replyToId))
          .catch((err) => console.error("[telegram] Title override error:", err instanceof Error ? err.message : err));
      }
    }
  });

  bot.onText(/\/start/, (msg) => {
    handleStart(msg).catch((err) =>
      console.error("[telegram] /start error:", err instanceof Error ? err.message : err),
    );
  });

  bot.onText(/\/status/, (msg) => {
    handleStatus(msg).catch((err) =>
      console.error("[telegram] /status error:", err instanceof Error ? err.message : err),
    );
  });

  bot.onText(/\/goal/, (msg) => {
    handleGoal(msg).catch((err) =>
      console.error("[telegram] /goal error:", err instanceof Error ? err.message : err),
    );
  });

  bot.onText(/\/tier/, (msg) => {
    handleTier(msg).catch((err) =>
      console.error("[telegram] /tier error:", err instanceof Error ? err.message : err),
    );
  });

  // ── Approval callback handler (✅/❌ buttons) ────────────────────────
  bot.on("callback_query", (query) => {
    handleApprovalCallback(query).catch((err) =>
      console.error("[telegram] callback_query error:", err instanceof Error ? err.message : err),
    );
  });

  bot.on("polling_error", (err) => {
    const is409 = err.message?.includes("409") || (err as any)?.response?.statusCode === 409;
    if (is409 && !restarting) {
      restarting = true;
      console.warn("[telegram] 409 Conflict detected — stopping polling and restarting in 5s");
      bot!.stopPolling().then(() => {
        setTimeout(() => {
          restarting = false;
          console.log("[telegram] Restarting bot polling after 409 conflict");
          bot!.startPolling();
        }, 5000);
      }).catch((stopErr) => {
        restarting = false;
        console.error("[telegram] Failed to stop polling:", stopErr instanceof Error ? stopErr.message : stopErr);
      });
    } else if (!is409) {
      console.error("[telegram] Polling error (non-fatal):", err.message);
    }
  });
}

export function startBot(): void {
  const config = env();
  bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
  registerHandlers();
  console.log("[telegram] Bot polling started");

  // Verify outbound messaging works on startup
  bot.sendMessage(config.TELEGRAM_CHAT_ID, "Monitor bot started.").then(() => {
    console.log("[telegram] Startup message sent");
  }).catch((err) => {
    console.error(`[telegram] Startup message FAILED (check TELEGRAM_CHAT_ID): ${err instanceof Error ? err.message : err}`);
  });
}
