/**
 * Bytewave Networks SMS gateway client.
 *
 * Spec (from https://portal.bytewavenetworks.com/api/http/sms/send docs):
 *   - POST /api/http/sms/send
 *   - JSON body: { api_token, recipient, sender_id, type: "plain", message }
 *   - Response envelope:
 *       success → { status: "success", data: "..." }
 *       error   → { status: "error",   message: "..." }
 *
 * Deployment quirks discovered empirically:
 *   - Their nginx 404s requests with non-curl User-Agents AND application/json
 *     Content-Type. A curl/* UA + form-urlencoded body reliably reaches Laravel.
 *   - api_token contains '|' which URLSearchParams encodes to %7C; their
 *     parser doesn't decode it, so we splice the token in raw at the end.
 *   - sender_id must be registered + approved in your Bytewave portal first
 *     (we default to "HUBNET" which is the configured shared-tenant sender).
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

  const senderId = cfg.senderId || config.brandName.slice(0, 11);

  // form-urlencoded body. Splice the api_token in raw (no URL encoding)
  // so the '|' survives Bytewave's parser. Every other field gets
  // encodeURIComponent treatment.
  const enc = (v: string) => encodeURIComponent(v);
  const bodyParts = [
    `recipient=${enc(to)}`,
    `sender_id=${enc(senderId)}`,
    `message=${enc(message)}`,
    `type=plain`,
    `api_token=${cfg.apiKey}`,
  ];
  const body = bodyParts.join('&');

  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        // curl-style UA bypasses Bytewave's nginx fingerprint that
        // 404s "browser-like" UAs on this endpoint.
        'User-Agent': 'curl/8.0.0',
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (err) {
    return { ok: false, detail: `network: ${(err as Error).message}` };
  }

  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {/* not json */}

  // Redacted URL for diagnostics — useful when Bytewave validates the
  // body and we want to see which fields the dispatcher actually sent.
  const redactedBody = body.replace(/api_token=[^&]+/, 'api_token=<REDACTED>');

  if (json?.status === 'error') {
    return {
      ok: false,
      detail: `${json.message ?? 'rejected (no message)'} | sent body=${redactedBody}`,
    };
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
      detail: `http ${res.status} ${res.statusText || ''}: ${bodyPreview || '(empty body)'} | sent body=${redactedBody}`,
    };
  }
  return { ok: true, detail: bodyPreview || 'sent (no envelope)' };
}
