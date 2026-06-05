import { getSmsConfig } from '../settings/service.js';

/**
 * Africa's Talking SMS client. Reads creds from DB-resolved settings
 * (admin can change via /settings without a redeploy) with env-var fallback.
 * Uses global fetch — no SDK dependency.
 */

export async function sendSms(to: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const cfg = (await getSmsConfig()).africastalking;
  const base = cfg.username === 'sandbox'
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';

  const params = new URLSearchParams({
    username: cfg.username,
    to,
    message,
    ...(cfg.senderId ? { from: cfg.senderId } : {}),
  });

  const res = await fetch(base, {
    method: 'POST',
    headers: {
      apiKey: cfg.apiKey,
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
