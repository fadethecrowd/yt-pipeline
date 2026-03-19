import TelegramBot from "node-telegram-bot-api";
import { env } from "./config";
import { prisma } from "./lib/prisma";

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

// ── Bot initialization ──────────────────────────────────────────────────

let restarting = false;

function registerHandlers(): void {
  if (!bot) return;

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
}
