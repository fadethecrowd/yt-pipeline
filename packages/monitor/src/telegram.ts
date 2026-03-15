import { env } from "./config";

/**
 * Send a plain-text message via the Telegram Bot API.
 */
export async function sendTelegram(text: string): Promise<void> {
  const config = env();
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
