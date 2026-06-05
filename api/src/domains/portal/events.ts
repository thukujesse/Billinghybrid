/**
 * Portal events — append-only diagnostic log of captive-portal touchpoints.
 *
 * emit() is fire-and-forget; failures are swallowed (never break the
 * customer flow that triggered the event). queryByMac()/queryByPhone()
 * power the /diagnostics admin page.
 *
 * For UNION with the older auto_reconnect_log table see traceForMac() /
 * traceForPhone() below — they merge both sources into one timeline.
 */
import { query } from '../../db/pool.js';
import { normalizeMac } from '../hotspotDevices/service.js';
import { normalizeMsisdn } from '../payments/daraja.js';

export type PortalEventType =
  | 'portal_load'
  | 'quick_connect'
  | 'voucher_redeem'
  | 'stk_init'
  | 'stk_callback'
  | 'stk_status_flip'
  | 'rebind_start'
  | 'rebind_verify'
  | 'grant_issued'
  | 'token_mint'
  | 'token_revoke'
  | 'forget_device'
  | 'lookup_miss'
  | 'erase_start'
  | 'erase_verify';

export interface EmitInput {
  type: PortalEventType;
  mac?: string | null;
  phone?: string | null;
  routerId?: string | null;
  tenant?: string | null;
  success?: boolean | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
  sourceIp?: string | null;
  userAgent?: string | null;
}

/**
 * Fire-and-forget insert. Errors are logged but never thrown — observability
 * must never break the hot path. Returns void (don't await for correctness;
 * the caller can await purely to backpressure logging during load tests).
 */
export async function emit(i: EmitInput): Promise<void> {
  try {
    const mac = i.mac ? normalizeMac(i.mac) : null;
    const phone = i.phone ? safeNormalizePhone(i.phone) : null;
    await query(
      `INSERT INTO portal_events
         (event_type, mac, phone, router_id, tenant, success, reason, detail, source_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        i.type,
        mac,
        phone,
        i.routerId ?? null,
        i.tenant ?? null,
        i.success ?? null,
        i.reason ?? null,
        JSON.stringify(i.detail ?? {}),
        i.sourceIp ?? null,
        i.userAgent ?? null,
      ]
    );
  } catch (e) {
    console.error('[portal-events] emit failed:', (e as Error).message);
  }
}

function safeNormalizePhone(raw: string): string | null {
  try { return normalizeMsisdn(raw); } catch { return raw.slice(0, 32); }
}

// =========================================================================
// Diagnostics queries — unified across portal_events + auto_reconnect_log.
// =========================================================================

export interface TraceRow {
  source: 'portal_event' | 'auto_reconnect';
  id: string;
  created_at: string;
  event_type: string;     // for auto_reconnect_log this is `method.outcome`
  mac: string | null;
  phone: string | null;
  success: boolean | null;
  reason: string | null;
  detail: Record<string, unknown>;
  source_ip: string | null;
  user_agent: string | null;
  router_id: string | null;
  tenant: string | null;
}

/**
 * Chronological trace of EVERYTHING that happened for this MAC across
 * both event tables. Newest first; capped at `limit` rows.
 */
export async function traceForMac(mac: string, limit = 200): Promise<TraceRow[]> {
  const n = Math.min(Math.max(limit, 1), 1000);
  const m = normalizeMac(mac);
  if (!m) return [];
  const r = await query<TraceRow>(
    `
    SELECT * FROM (
      SELECT 'portal_event'::text AS source,
             id::text, created_at, event_type,
             mac, phone, success, reason, detail,
             source_ip::text AS source_ip, user_agent,
             router_id::text AS router_id, tenant
        FROM portal_events
       WHERE mac = $1
      UNION ALL
      SELECT 'auto_reconnect'::text AS source,
             id::text, created_at,
             (method || '.' || outcome) AS event_type,
             mac, phone,
             (outcome = 'success') AS success,
             CASE WHEN outcome = 'success' THEN NULL ELSE outcome END AS reason,
             jsonb_build_object(
               'method', method,
               'token_id', token_id,
               'fingerprint_match', fingerprint_match,
               'notes', notes
             ) AS detail,
             source_ip::text AS source_ip, user_agent,
             NULL::text AS router_id, NULL::text AS tenant
        FROM auto_reconnect_log
       WHERE mac = $1
    ) t
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [m, n]
  );
  return r.rows;
}

export async function traceForPhone(phone: string, limit = 200): Promise<TraceRow[]> {
  const n = Math.min(Math.max(limit, 1), 1000);
  let p: string;
  try { p = normalizeMsisdn(phone); } catch { return []; }
  const r = await query<TraceRow>(
    `
    SELECT * FROM (
      SELECT 'portal_event'::text AS source,
             id::text, created_at, event_type,
             mac, phone, success, reason, detail,
             source_ip::text AS source_ip, user_agent,
             router_id::text AS router_id, tenant
        FROM portal_events
       WHERE phone = $1
      UNION ALL
      SELECT 'auto_reconnect'::text AS source,
             id::text, created_at,
             (method || '.' || outcome) AS event_type,
             mac, phone,
             (outcome = 'success') AS success,
             CASE WHEN outcome = 'success' THEN NULL ELSE outcome END AS reason,
             jsonb_build_object(
               'method', method,
               'token_id', token_id,
               'fingerprint_match', fingerprint_match,
               'notes', notes
             ) AS detail,
             source_ip::text AS source_ip, user_agent,
             NULL::text AS router_id, NULL::text AS tenant
        FROM auto_reconnect_log
       WHERE phone = $1
    ) t
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [p, n]
  );
  return r.rows;
}

export interface RecentSummary {
  windowHours: number;
  total: number;
  byType: Record<string, number>;
  successRate: number | null;     // null if no events with success=TRUE/FALSE
  stkSuccessRate: number | null;  // stk_callback success rate specifically
  uniqueMacs: number;
  uniquePhones: number;
}

export async function recentSummary(windowHours = 24): Promise<RecentSummary> {
  const h = Math.min(Math.max(windowHours, 1), 168);
  const r = await query<{
    total: number;
    by_type: Record<string, number>;
    successes: number;
    failures: number;
    stk_successes: number;
    stk_failures: number;
    unique_macs: number;
    unique_phones: number;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       jsonb_object_agg(event_type, n) FILTER (WHERE event_type IS NOT NULL) AS by_type,
       COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0)::int AS successes,
       COALESCE(SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END), 0)::int AS failures,
       COALESCE(SUM(CASE WHEN event_type = 'stk_callback' AND success THEN 1 ELSE 0 END), 0)::int AS stk_successes,
       COALESCE(SUM(CASE WHEN event_type = 'stk_callback' AND success = FALSE THEN 1 ELSE 0 END), 0)::int AS stk_failures,
       COUNT(DISTINCT mac)::int AS unique_macs,
       COUNT(DISTINCT phone)::int AS unique_phones
     FROM (
       SELECT event_type, success, mac, phone, COUNT(*) OVER (PARTITION BY event_type) AS n
         FROM portal_events
        WHERE created_at > now() - ($1 || ' hours')::interval
     ) t`,
    [String(h)]
  );
  const row = r.rows[0];
  const withOutcome = (row?.successes ?? 0) + (row?.failures ?? 0);
  const stkWithOutcome = (row?.stk_successes ?? 0) + (row?.stk_failures ?? 0);
  return {
    windowHours: h,
    total: row?.total ?? 0,
    byType: row?.by_type ?? {},
    successRate: withOutcome > 0 ? Math.round((row!.successes / withOutcome) * 1000) / 10 : null,
    stkSuccessRate: stkWithOutcome > 0 ? Math.round((row!.stk_successes / stkWithOutcome) * 1000) / 10 : null,
    uniqueMacs: row?.unique_macs ?? 0,
    uniquePhones: row?.unique_phones ?? 0,
  };
}
