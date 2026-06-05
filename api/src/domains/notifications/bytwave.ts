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

  // First try POST as the docs specify. If we get a 404 or other
  // non-2xx, fall back to GET with query string — the docs publish a
  // GET example as a valid alternative, and Laravel apps sometimes
  // only register one of the two methods on the route.
  const tryRequest = async (mode: 'post' | 'get'): Promise<BytwaveResponse> => {
    let res: Response;
    try {
      if (mode === 'post') {
        res = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(payload),
        });
      } else {
        const qs = new URLSearchParams({
          api_token: cfg.apiKey,
          recipient: to,
          sender_id: senderId,
          type: 'plain',
          message,
        }).toString();
        const url = cfg.endpoint + (cfg.endpoint.includes('?') ? '&' : '?') + qs;
        res = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
        });
      }
    } catch (err) {
      return { ok: false, detail: `network[${mode}]: ${(err as Error).message}` };
    }

    // Read body as TEXT first so empty / HTML / non-JSON responses still
    // give us SOMETHING useful in the detail. Then try JSON parse.
    const text = await res.text().catch(() => '');
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {/* not json */}

    if (json?.status === 'error') {
      return { ok: false, detail: `[${mode}] ${json.message ?? 'rejected (no message)'}` };
    }
    if (json?.status === 'success') {
      const data = typeof json.data === 'string'
        ? json.data
        : JSON.stringify(json.data ?? {}).slice(0, 120);
      return { ok: true, detail: `[${mode}] ${data || 'sent'}` };
    }
    // No envelope — include first 200 chars of body so the operator can
    // see whether Bytewave returned HTML (Laravel 404 page), an unknown
    // JSON shape, or nothing.
    const bodyPreview = text.slice(0, 200).replace(/\s+/g, ' ');
    if (!res.ok) {
      return {
        ok: false,
        detail: `[${mode}] http ${res.status} ${res.statusText || ''}: ${bodyPreview || '(empty body)'}`,
      };
    }
    return { ok: true, detail: `[${mode}] ${bodyPreview || 'sent (no envelope)'}` };
  };

  const postResult = await tryRequest('post');
  // POST worked OR failed in a way that's not 404 → return that. Only
  // try GET when POST returns 404 specifically (route not registered).
  if (postResult.ok || !postResult.detail.includes('http 404')) {
    return postResult;
  }
  const getResult = await tryRequest('get');
  // If GET succeeded, return it. Otherwise return both detail strings
  // so the operator can see both failures.
  if (getResult.ok) return getResult;
  return {
    ok: false,
    detail: `POST: ${postResult.detail} | GET: ${getResult.detail}`,
  };
}
