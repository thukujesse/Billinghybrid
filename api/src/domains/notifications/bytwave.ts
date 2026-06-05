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
 *   - Their nginx 404s requests with browser-like User-Agents — must send
 *     a curl/* UA (or similar) to reach the Laravel app at all.
 *   - Form-urlencoded bodies reach Laravel but $request->all() returns
 *     empty for this route, so validation fails with "recipient required"
 *     even when the body has it. JSON body is what their parser reads.
 *   - sender_id must be registered + approved in your Bytewave portal
 *     (default "HUBNET" — the configured shared-tenant sender).
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

  // Bytewave Laravel only parses JSON bodies on this endpoint — sending
  // form-urlencoded reaches the route but $request->all() returns empty,
  // so validation fails with "recipient required" even when the body
  // clearly has it. Docs example uses JSON; matching that.
  const body = JSON.stringify({
    api_token: cfg.apiKey,
    recipient: to,
    sender_id: senderId,
    type: 'plain',
    message,
  });

  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        // curl-style UA — Bytewave's nginx 404s "browser-like" UAs on
        // this endpoint regardless of content-type. curl/* sails through.
        'User-Agent': 'curl/8.0.0',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch (err) {
    return { ok: false, detail: `network: ${(err as Error).message}` };
  }

  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {/* not json */}

  // Redacted body for diagnostics — useful when Bytewave validates and
  // we want to see what the dispatcher actually sent. JSON now, so the
  // regex matches the "api_token":"..." pattern instead of url-encoded.
  const redactedBody = body.replace(/"api_token":"[^"]+"/, '"api_token":"<REDACTED>"');

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
