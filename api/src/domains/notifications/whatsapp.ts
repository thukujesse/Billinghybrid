import { config } from '../../config.js';

/**
 * WhatsApp Business (Meta Cloud API) client. Active only when a phone-number
 * id + access token are configured; otherwise the notification service logs
 * instead of sending. Uses global fetch — no SDK dependency.
 *
 * Supports both free-form text (only valid inside the 24h customer-care
 * window) and pre-approved template messages (required to initiate a
 * conversation cold — e.g. a payment receipt or suspension alert).
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

/**
 * Build the Cloud API payload for a template message. `bodyParams` fill the
 * {{1}}, {{2}}, ... placeholders in the template's BODY component, in order.
 * Extracted so the shape is unit-testable without a network call.
 */
export function buildTemplatePayload(
  to: string,
  templateName: string,
  bodyParams: string[],
  langCode = 'en'
): Record<string, unknown> {
  const components =
    bodyParams.length > 0
      ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
      : [];
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: langCode },
      ...(components.length ? { components } : {}),
    },
  };
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    return { ok: false, detail: data?.error?.message ?? `WA error ${res.status}` };
  }
  return { ok: true, detail: data?.messages?.[0]?.id ?? 'sent' };
}

export async function sendWhatsApp(to: string, message: string): Promise<{ ok: boolean; detail: string }> {
  return post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId(to),
    type: 'text',
    text: { preview_url: false, body: message },
  });
}

export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  bodyParams: string[] = [],
  langCode = 'en'
): Promise<{ ok: boolean; detail: string }> {
  return post(buildTemplatePayload(to, templateName, bodyParams, langCode));
}
