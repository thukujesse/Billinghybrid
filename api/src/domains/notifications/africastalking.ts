import { config } from '../../config.js';

/**
 * Africa's Talking SMS client. Active only when an API key + username are
 * configured; otherwise the notification service logs instead of sending.
 * Uses global fetch — no SDK dependency.
 */

const BASE =
  config.sms.username === 'sandbox'
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';

export async function sendSms(to: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const params = new URLSearchParams({
    username: config.sms.username,
    to,
    message,
    ...(config.sms.senderId ? { from: config.sms.senderId } : {}),
  });

  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      apiKey: config.sms.apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) return { ok: false, detail: `AT error ${res.status}` };
  const recipients = data?.SMSMessageData?.Recipients ?? [];
  const status = recipients[0]?.status ?? 'unknown';
  return { ok: status === 'Success', detail: status };
}
