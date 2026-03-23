import TelegramBot from "node-telegram-bot-api";
import { env } from "./config";
import { prisma } from "./lib/prisma";
import { ActionStatus } from "./lib/types";
import type { Decision } from "./lib/types";

let bot: TelegramBot | null = null;

// Track last tick time for /status command
let lastTickTime: Date | null = null;

export function setLastTickTime(time: Date): void {
  lastTickTime = time;
}

/**
 * Send a plain-text message via the Telegram Bot API.
 */
export async function sendTelegram(text: string): Promise<void> {
  const config = env();

  if (bot) {
    try {
      await bot.sendMessage(config.TELEGRAM_CHAT_ID, text, { parse_mode: "Markdown" });
    } catch (err) {
      console.error("[telegram] Send failed:", err instanceof Error ? err.message : err);
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
      parse_mode: "Markdown",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] API error ${res.status}: ${body}`);
  }
}

/**
 * Send an alert message.
 */
export async function sendAlert(message: string): Promise<void> {
  try {
    await sendTelegram(`⚠️ *Alert*\n${message}`);
    console.log(`[telegram] Alert sent: ${message}`);
  } catch (err) {
    console.error("[telegram] Alert send failed (non-fatal):", err instanceof Error ? err.message : err);
  }
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

async function handleStatus(msg: TelegramBot.Message): Promise<void> {
  try {
    const videoCount = await prisma.video.count({
      where: { youtubeId: { not: null } },
    });
    const recentDecisions = await prisma.monitorAction.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    const lastSnapshot = await prisma.videoSnapshot.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    const lines = [
      "📊 *Monitor Status*",
      "",
      `Last tick: ${lastTickTime ? lastTickTime.toISOString() : "not yet"}`,
      `Last snapshot: ${lastSnapshot ? lastSnapshot.createdAt.toISOString() : "none"}`,
      `Videos tracked: ${videoCount}`,
      `Decisions (24h): ${recentDecisions}`,
    ];

    await bot!.sendMessage(msg.chat.id, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[telegram] /status failed:", err instanceof Error ? err.message : err);
    await bot!.sendMessage(msg.chat.id, "Failed to fetch status.");
  }
}

async function handleGoal(msg: TelegramBot.Message): Promise<void> {
  const text = msg.text ?? "";
  const args = text.replace(/^\/goal\s*/, "").trim();

  try {
    if (!args) {
      // Show current goal
      const goal = await prisma.channelGoal.findFirst({
        orderBy: { updatedAt: "desc" },
      });
      if (!goal) {
        await bot!.sendMessage(msg.chat.id, "No goal set. Use `/goal <text>` to set one.", { parse_mode: "Markdown" });
      } else {
        await bot!.sendMessage(
          msg.chat.id,
          `🎯 *Current Goal*\n${goal.goal}\n\nAutonomy tier: ${goal.autonomyTier}`,
          { parse_mode: "Markdown" },
        );
      }
      return;
    }

    // Upsert goal — update existing or create new
    const existing = await prisma.channelGoal.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    if (existing) {
      await prisma.channelGoal.update({
        where: { id: existing.id },
        data: { goal: args },
      });
    } else {
      await prisma.channelGoal.create({
        data: { goal: args },
      });
    }

    await bot!.sendMessage(msg.chat.id, `✅ Goal saved: ${args}`);
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
    const existing = await prisma.channelGoal.findFirst({
      orderBy: { updatedAt: "desc" },
    });

    if (!existing) {
      await bot!.sendMessage(msg.chat.id, "Set a goal first with `/goal <text>`", { parse_mode: "Markdown" });
      return;
    }

    await prisma.channelGoal.update({
      where: { id: existing.id },
      data: { autonomyTier: tier },
    });

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

  const monitorAction = await prisma.monitorAction.findUnique({
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

    await prisma.monitorAction.update({
      where: { id: actionId },
      data: {
        status: result.success ? ActionStatus.EXECUTED : ActionStatus.FAILED,
        result: result.message,
        executedAt: new Date(),
      },
    });

    const emoji = result.success ? "\u2705" : "\u274C";
    await bot!.editMessageText(
      `${emoji} *${monitorAction.type}* — ${result.success ? "Approved & executed" : "Approved but execution failed"}\n${result.message}`,
      {
        chat_id: query.message!.chat.id,
        message_id: query.message!.message_id,
        parse_mode: "Markdown",
      },
    );
    await bot!.answerCallbackQuery(query.id, { text: result.success ? "Executed!" : "Execution failed" });
    console.log(`[telegram] Action ${actionId} approved → ${result.success ? "EXECUTED" : "FAILED"}: ${result.message}`);
  } else {
    await prisma.monitorAction.update({
      where: { id: actionId },
      data: { status: ActionStatus.SKIPPED, result: "Rejected by user" },
    });

    await bot!.editMessageText(
      `\u274C *${monitorAction.type}* — Rejected\nVideo: \`${monitorAction.videoId}\``,
      {
        chat_id: query.message!.chat.id,
        message_id: query.message!.message_id,
        parse_mode: "Markdown",
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
  await prisma.video.update({
    where: { id: videoId },
    data: { seoTitle: selectedTitle },
  });

  // Update the MonitorAction payload to reflect the override
  await prisma.monitorAction.update({
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
