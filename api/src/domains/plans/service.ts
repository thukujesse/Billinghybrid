import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { notFound } from '../../lib/errors.js';

export interface Plan {
  id: string;
  name: string;
  type: 'prepaid' | 'postpaid' | 'hotspot';
  price_cents: number;
  currency: string;
  billing_cycle: 'none' | 'daily' | 'weekly' | 'monthly';
  validity_days: number;
  data_cap_mb: number | null;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
  fup_threshold_pct: number;
  active: boolean;
}

export interface CreatePlanInput {
  name: string;
  type: Plan['type'];
  price_cents: number;
  billing_cycle?: Plan['billing_cycle'];
  validity_days?: number;
  data_cap_mb?: number | null;
  speed_down_kbps?: number | null;
  speed_up_kbps?: number | null;
  fup_threshold_pct?: number;
}

export async function listPlans(includeInactive = false): Promise<Plan[]> {
  const r = await query<Plan>(
    `SELECT * FROM plans ${includeInactive ? '' : 'WHERE active = TRUE'} ORDER BY price_cents ASC`
  );
  return r.rows;
}

export async function getPlan(id: string): Promise<Plan> {
  const r = await query<Plan>('SELECT * FROM plans WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('plan');
  return r.rows[0];
}

export async function createPlan(input: CreatePlanInput): Promise<Plan> {
  const r = await query<Plan>(
    `INSERT INTO plans
       (name, type, price_cents, currency, billing_cycle, validity_days,
        data_cap_mb, speed_down_kbps, speed_up_kbps, fup_threshold_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      input.name,
      input.type,
      input.price_cents,
      config.currency,
      input.billing_cycle ?? (input.type === 'postpaid' ? 'monthly' : 'none'),
      input.validity_days ?? 30,
      input.data_cap_mb ?? null,
      input.speed_down_kbps ?? null,
      input.speed_up_kbps ?? null,
      input.fup_threshold_pct ?? 80,
    ]
  );
  return r.rows[0];
}
