import { config } from '../../config.js';

/**
 * Email sender via the SendGrid v3 HTTP API. Active only when an API key is
 * configured; otherwise the notification service logs. Uses global fetch — no
 * SDK dependency. (SES could be added as an alternate provider behind the same
 * sendEmail() signature.)
 */

/** Build the SendGrid v3 request body (extracted so it's unit-testable). */
export function buildSendgridPayload(
  to: string,
  subject: string,
  body: string,
  from: string
): Record<string, unknown> {
  return {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from },
    subject,
    content: [{ type: 'text/plain', value: body }],
  };
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildSendgridPayload(to, subject, body, config.email.from)),
  });
  // SendGrid returns 202 with an empty body on success.
  if (res.status === 202) return { ok: true, detail: 'queued' };
  const text = await res.text().catch(() => '');
  return { ok: false, detail: `SG error ${res.status}${text ? ': ' + text.slice(0, 120) : ''}` };
}
