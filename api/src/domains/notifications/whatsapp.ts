import { config } from '../../config.js';

/**
 * WhatsApp Business (Meta Cloud API) client. Active only when a phone-number
 * id + access token are configured; otherwise the notification service logs
 * instead of sending. Uses global fetch — no SDK dependency.
 *
 * Sends a plain text message. (Meta requires pre-approved templates to open a
 * conversation outside the 24h customer-care window; for that, extend this to
 * the `template` message type with components.)
 */

function endpoint(): string {
  return `https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}/messages`;
}

/** Normalize to a WhatsApp wa_id (digits, country code, no +). */
export function toWaId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) return `254${digits.slice(1)}`; // KE default
  return digits;
}

export async function sendWhatsApp(to: string, message: string): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId(to),
      type: 'text',
      text: { preview_url: false, body: message },
    }),
  });

  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    return { ok: false, detail: data?.error?.message ?? `WA error ${res.status}` };
  }
  const id = data?.messages?.[0]?.id ?? 'sent';
  return { ok: true, detail: id };
}
