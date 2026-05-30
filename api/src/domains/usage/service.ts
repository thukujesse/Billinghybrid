import { query } from '../../db/pool.js';
import { getPlan } from '../plans/service.js';
import { provisioning } from '../provisioning/service.js';
import { emit } from '../events/bus.js';

/**
 * Usage Metering & FUP enforcement (Data Flow 03). Ingests accounting data
 * (bytes in/out) for a subscriber's active subscription, accumulates the total
 * for the current cycle, and enforces the plan's data cap:
 *   - at fup_threshold_pct  -> emit an alert (SMS/WhatsApp upstream)
 *   - at 100%               -> throttle via Provisioning
 * Unlimited plans (data_cap_mb = NULL) never throttle.
 */
export async function ingestUsage(input: {
  subscriberId: string;
  bytesIn: number;
  bytesOut: number;
}): Promise<{
  totalBytes: number;
  capBytes: number | null;
  usedPct: number | null;
  action: 'none' | 'alert' | 'throttle';
}> {
  // Find the active subscription + its plan.
  const subRow = await query(
    `SELECT s.id, s.plan_id FROM subscriptions s
     WHERE s.subscriber_id = $1 AND s.status = 'active'
     ORDER BY s.end_at DESC NULLS LAST LIMIT 1`,
    [input.subscriberId]
  );
  const sub = subRow.rows[0];

  await query(
    `INSERT INTO usage_records (subscriber_id, subscription_id, bytes_in, bytes_out)
     VALUES ($1,$2,$3,$4)`,
    [input.subscriberId, sub?.id ?? null, input.bytesIn, input.bytesOut]
  );

  // Accumulated usage for the current subscription window.
  const agg = await query<{ total: number }>(
    `SELECT COALESCE(SUM(bytes_in + bytes_out), 0)::bigint AS total
     FROM usage_records
     WHERE subscriber_id = $1 ${sub ? 'AND subscription_id = $2' : ''}`,
    sub ? [input.subscriberId, sub.id] : [input.subscriberId]
  );
  const totalBytes = Number(agg.rows[0].total);

  if (!sub) return { totalBytes, capBytes: null, usedPct: null, action: 'none' };

  const plan = await getPlan(sub.plan_id);
  if (plan.data_cap_mb == null) {
    return { totalBytes, capBytes: null, usedPct: null, action: 'none' };
  }

  const capBytes = plan.data_cap_mb * 1024 * 1024;
  const usedPct = Math.round((totalBytes / capBytes) * 100);

  if (usedPct >= 100) {
    await provisioning.throttle(input.subscriberId, { reason: 'fup_exhausted', usedPct });
    await emit('usage.fup.exceeded', { subscriberId: input.subscriberId, usedPct });
    return { totalBytes, capBytes, usedPct, action: 'throttle' };
  }
  if (usedPct >= plan.fup_threshold_pct) {
    await emit('usage.fup.threshold', { subscriberId: input.subscriberId, usedPct, threshold: plan.fup_threshold_pct });
    return { totalBytes, capBytes, usedPct, action: 'alert' };
  }
  return { totalBytes, capBytes, usedPct, action: 'none' };
}

export async function usageSummary(subscriberId: string) {
  const r = await query(
    `SELECT COALESCE(SUM(bytes_in),0)::bigint AS bytes_in,
            COALESCE(SUM(bytes_out),0)::bigint AS bytes_out,
            COUNT(*)::int AS records
     FROM usage_records WHERE subscriber_id = $1`,
    [subscriberId]
  );
  return r.rows[0];
}
