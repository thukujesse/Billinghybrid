/**
 * Bytwave SMS gateway client. Active only when BYTWAVE_API_KEY is set;
 * otherwise the notification service logs instead of sending.
 *
 * Bytwave's HTTP API is configurable here in case the path or payload
 * shape varies across their docs versions — set BYTWAVE_ENDPOINT to the
 * full URL and BYTWAVE_PAYLOAD_FORMAT to 'json' (default) or 'form'.
 * Default request body: { sender_id, mobile, message } as JSON with
 * Authorization: Bearer <key>.
 *
 * If your Bytwave account uses a different envelope, override via env
 * vars or adjust the buildPayload + parseResponse functions below.
 */
import { config } from '../../config.js';

interface BytwaveResponse {
  ok: boolean;
  detail: string;
}

function buildPayload(to: string, message: string): { body: string; contentType: string } {
  const fields: Record<string, string> = {
    sender_id: config.sms.bytwave.senderId,
    mobile: to,
    message,
  };
  if (config.sms.bytwave.payloadFormat === 'form') {
    const usp = new URLSearchParams(fields);
    return { body: usp.toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  return { body: JSON.stringify(fields), contentType: 'application/json' };
}

function parseResponse(httpOk: boolean, status: number, json: any): BytwaveResponse {
  // Bytwave commonly returns either { status: 'success', ... } or
  // { code: 200, message: 'Sent', ... }. Treat HTTP 2xx as success unless
  // the body explicitly flags failure. Keep the detail human-readable
  // so the operator log line is useful.
  if (!httpOk) return { ok: false, detail: `bytwave error ${status}: ${json?.message ?? 'unknown'}` };
  const explicitFail = json?.status === 'error' || json?.status === 'failed' || json?.success === false;
  if (explicitFail) return { ok: false, detail: json?.message ?? json?.error ?? 'rejected' };
  return { ok: true, detail: json?.message ?? json?.status ?? 'sent' };
}

export async function sendBytwaveSms(to: string, message: string): Promise<BytwaveResponse> {
  if (!config.sms.bytwave.apiKey) {
    return { ok: false, detail: 'bytwave not configured' };
  }
  const { body, contentType } = buildPayload(to, message);
  const res = await fetch(config.sms.bytwave.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Accept': 'application/json',
      'Authorization': `Bearer ${config.sms.bytwave.apiKey}`,
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return parseResponse(res.ok, res.status, json);
}
