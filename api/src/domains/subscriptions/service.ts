import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { getPlan, type Plan } from '../plans/service.js';

export interface Subscription {
  id: string;
  subscriber_id: string;
  plan_id: string;
  status: 'pending' | 'active' | 'suspended' | 'expired';
  start_at: string | null;
  end_at: string | null;
  auto_renew: boolean;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Activate (or extend) a subscriber on a plan. If an active subscription for
 * the same plan exists, its validity is extended from its current end date —
 * this is how top-ups and voucher redemptions stack ("Plan Extend").
 */
export async function activateForPlan(
  subscriberId: string,
  planId: string,
  client?: PoolClient
): Promise<Subscription> {
  const plan = await getPlan(planId);
  const now = new Date();

  const existing = await query<Subscription>(
    `SELECT * FROM subscriptions
     WHERE subscriber_id = $1 AND plan_id = $2 AND status IN ('active','suspended')
     ORDER BY end_at DESC NULLS LAST LIMIT 1`,
    [subscriberId, planId],
    client
  );

  if (existing.rows[0]) {
    const current = existing.rows[0];
    const base = current.end_at && new Date(current.end_at) > now ? new Date(current.end_at) : now;
    const newEnd = addDays(base, plan.validity_days);
    const r = await query<Subscription>(
      `UPDATE subscriptions SET status = 'active', start_at = COALESCE(start_at, $2), end_at = $3
       WHERE id = $1 RETURNING *`,
      [current.id, now.toISOString(), newEnd.toISOString()],
      client
    );
    return r.rows[0];
  }

  const end = addDays(now, plan.validity_days);
  const r = await query<Subscription>(
    `INSERT INTO subscriptions (subscriber_id, plan_id, status, start_at, end_at)
     VALUES ($1, $2, 'active', $3, $4)
     RETURNING *`,
    [subscriberId, planId, now.toISOString(), end.toISOString()],
    client
  );
  // Make sure the subscriber account is active too.
  await query(`UPDATE subscribers SET status = 'active' WHERE id = $1 AND status != 'suspended'`, [subscriberId], client);
  return r.rows[0];
}

export async function listForSubscriber(subscriberId: string): Promise<Subscription[]> {
  const r = await query<Subscription>(
    'SELECT * FROM subscriptions WHERE subscriber_id = $1 ORDER BY created_at DESC',
    [subscriberId]
  );
  return r.rows;
}

/** Postpaid subscriptions whose cycle has ended and need a new invoice. */
export async function dueForBilling(): Promise<(Subscription & { plan: Plan })[]> {
  const r = await query(
    `SELECT s.*, row_to_json(p.*) AS plan
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'active'
       AND p.billing_cycle != 'none'
       AND (s.end_at IS NULL OR s.end_at <= now())`
  );
  return r.rows as any;
}
