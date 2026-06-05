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

  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, detail: `network: ${(err as Error).message}` };
  }

  const json = await res.json().catch(() => ({} as any));

  // Bytewave's own envelope wins over the HTTP status — they sometimes
  // return 200 with status:"error" (validation rejections).
  if (json?.status === 'error') {
    return { ok: false, detail: json.message ?? 'rejected (no message)' };
  }
  if (json?.status === 'success') {
    const data = typeof json.data === 'string'
      ? json.data
      : JSON.stringify(json.data ?? {}).slice(0, 120);
    return { ok: true, detail: data || 'sent' };
  }
  // No status envelope — fall back to HTTP code.
  if (!res.ok) {
    return { ok: false, detail: `http ${res.status}: ${json?.message ?? JSON.stringify(json).slice(0, 120) ?? 'unknown'}` };
  }
  return { ok: true, detail: 'sent (no envelope)' };
}
