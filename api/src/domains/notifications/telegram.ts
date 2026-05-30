import { config } from '../../config.js';

/**
 * Telegram Bot client (Bot API). Active only when a bot token is configured;
 * otherwise the notification service logs. Uses global fetch — no SDK.
 */

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;
}

/** Send a message to a chat. `chatId` may be a channel/user id or @username. */
export async function sendTelegram(chatId: string, text: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(apiUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.ok) {
    return { ok: false, detail: data?.description ?? `TG error ${res.status}` };
  }
  return { ok: true, detail: String(data.result?.message_id ?? 'sent') };
}
