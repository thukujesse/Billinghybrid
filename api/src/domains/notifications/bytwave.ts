/**
 * Bytewave Networks SMS gateway client.
 *
 * Spec (from https://portal.bytewavenetworks.com/api/http/sms/send docs):
 *   - POST /api/http/sms/send
 *   - Content-Type: application/json
 *   - Accept: application/json
 *   - NO Authorization header — the api_token rides in the JSON body
 *   - JSON body shape:
 *       { api_token, recipient, sender_id, type: "plain", message }
 *   - Response:
 *       success → { status: "success", data: "..." }
 *       error   → { status: "error",   message: "..." }
 *
 * Note: their auth scheme (token in body) is unusual but matches their
 * published examples verbatim. Don't switch to Bearer — it'll 401.
 */
import { getSmsConfig } from '../settings/service.js';
import { config } from '../../config.js';

interface BytwaveResponse {
  ok: boolean;
  detail: string;
}

export async function sendBytwaveSms(to: string, message: string): Promise<BytwaveResponse> {
  const cfg = (await getSmsConfig()).bytwave;
  if (!cfg.apiKey) return { ok: false, detail: 'bytwave not configured (no api_token)' };

  // Bytewave requires sender_id and rejects without one. If the operator
  // hasn't set one, fall back to first 11 chars of the brand name so the
  // send doesn't silently fail at the gateway.
  const senderId = cfg.senderId || config.brandName.slice(0, 11);

  const payload = {
    api_token: cfg.apiKey,
    recipient: to,
    sender_id: senderId,
    type: 'plain' as const,
    message,
  };

  // Bytewave's live deployment 404s on POST despite their docs publishing
  // a POST example. Their working API is GET-only. URL-encode every value
  // EXCEPT the api_token's '|' separator — URLSearchParams encodes pipe
  // to %7C which Bytewave's token parser doesn't decode, so we build the
  // query string manually to match the docs example verbatim.
  const enc = (v: string) => encodeURIComponent(v);
  const qsParts = [
    `recipient=${enc(to)}`,
    `sender_id=${enc(senderId)}`,
    `message=${enc(message)}`,
    `type=plain`,
    // api_token last and not URL-encoded so '|' stays raw
    `api_token=${cfg.apiKey}`,
  ];
  const url = cfg.endpoint + (cfg.endpoint.includes('?') ? '&' : '?') + qsParts.join('&');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        // Explicit UA so Bytewave's nginx doesn't fingerprint undici and
        // route to a 404. JTM brand + portal host gives them something
        // to log if they ever want to track usage.
        'User-Agent': `${config.brandName} JTM-Billing/1.0 (+https://${config.portal.host})`,
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    return { ok: false, detail: `network: ${(err as Error).message}` };
  }

  // Read body as TEXT first so empty / HTML responses still surface
  // SOMETHING useful in the detail.
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {/* not json */}

  if (json?.status === 'error') {
    return { ok: false, detail: json.message ?? 'rejected (no message)' };
  }
  if (json?.status === 'success') {
    const data = typeof json.data === 'string'
      ? json.data
      : JSON.stringify(json.data ?? {}).slice(0, 120);
    return { ok: true, detail: data || 'sent' };
  }
  const bodyPreview = text.slice(0, 200).replace(/\s+/g, ' ');
  if (!res.ok) {
    return {
      ok: false,
      detail: `http ${res.status} ${res.statusText || ''}: ${bodyPreview || '(empty body)'}`,
    };
  }
  return { ok: true, detail: bodyPreview || 'sent (no envelope)' };
}
