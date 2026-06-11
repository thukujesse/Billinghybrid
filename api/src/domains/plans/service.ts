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
  /** Canonical fine-grained duration (1h=60, 1d=1440). Hotspot grants use this. */
  validity_minutes: number;
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
  validity_minutes?: number;
  data_cap_mb?: number | null;
  speed_down_kbps?: number | null;
  speed_up_kbps?: number | null;
  fup_threshold_pct?: number;
}

/** Resolve {validity_days, validity_minutes} from whichever the caller supplied,
 *  keeping them consistent. minutes is canonical; days is the whole-day approx
 *  for PPPoE date math (>=1). */
function resolveValidity(input: { validity_minutes?: number; validity_days?: number }): { days: number; minutes: number } {
  if (input.validity_minutes != null) {
    return { minutes: input.validity_minutes, days: Math.max(1, Math.round(input.validity_minutes / 1440)) };
  }
  const days = input.validity_days ?? 30;
  return { days, minutes: days * 1440 };
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

export interface UpdatePlanInput {
  name?: string;
  price_cents?: number;
  billing_cycle?: Plan['billing_cycle'];
  validity_days?: number;
  validity_minutes?: number;
  data_cap_mb?: number | null;
  speed_down_kbps?: number | null;
  speed_up_kbps?: number | null;
  fup_threshold_pct?: number;
  active?: boolean;
}

export async function updatePlan(id: string, input: UpdatePlanInput): Promise<Plan> {
  // Keep days + minutes in sync when either is edited.
  const patch: Record<string, unknown> = { ...input };
  if (input.validity_minutes != null || input.validity_days != null) {
    const { days, minutes } = resolveValidity(input);
    patch.validity_days = days;
    patch.validity_minutes = minutes;
  }
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (sets.length === 0) return getPlan(id);
  vals.push(id);
  const r = await query<Plan>(
    `UPDATE plans SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (!r.rows[0]) throw notFound('plan');
  return r.rows[0];
}

export async function createPlan(input: CreatePlanInput): Promise<Plan> {
  const { days, minutes } = resolveValidity(input);
  const r = await query<Plan>(
    `INSERT INTO plans
       (name, type, price_cents, currency, billing_cycle, validity_days, validity_minutes,
        data_cap_mb, speed_down_kbps, speed_up_kbps, fup_threshold_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.name,
      input.type,
      input.price_cents,
      config.currency,
      input.billing_cycle ?? (input.type === 'postpaid' ? 'monthly' : 'none'),
      days,
      minutes,
      input.data_cap_mb ?? null,
      input.speed_down_kbps ?? null,
      input.speed_up_kbps ?? null,
      input.fup_threshold_pct ?? 80,
    ]
  );
  return r.rows[0];
}
