import { query } from '../../db/pool.js';
import { isMpesaSimulated } from '../settings/service.js';
import * as renew from '../renew/service.js';

/**
 * Auto-STK renewal dunning. Fires an M-Pesa STK renewal prompt to lapsing
 * (or just-lapsed) manual-pay PPPoE customers so they renew with one PIN tap.
 *
 * OFF by default. Anti-spam guards: opt-in per ISP, an attempt cap PER CYCLE,
 * and a 20h re-prompt cooldown (last_stk_dun_at). We mark BEFORE firing so a
 * hung STK call can't cause a re-fire loop. Counters reset when the service
 * renews (see completePurchase). Wallet auto-renew customers (auto_renew=TRUE)
 * are handled by autoRenewDue and excluded here.
 */

export interface DunningConfig {
  enabled: boolean;
  maxAttempts: number;
  windowHours: number;   // prompt this many hours BEFORE expiry
  graceHours: number;    // keep prompting this many hours AFTER expiry
}

const REPROMPT_COOLDOWN_HOURS = 20;

export async function getDunningConfig(): Promise<DunningConfig> {
  const r = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key LIKE 'renewal.stk_dunning_%'`
  );
  const m = new Map(r.rows.map((x) => [x.key, x.value]));
  const num = (k: string, d: number) => {
    const n = Number(m.get(k));
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    enabled: m.get('renewal.stk_dunning_enabled') === 'true',
    maxAttempts: num('renewal.stk_dunning_max_attempts', 3),
    windowHours: num('renewal.stk_dunning_window_hours', 12),
    graceHours: num('renewal.stk_dunning_grace_hours', 72),
  };
}

export async function setDunningConfig(input: Partial<DunningConfig>): Promise<DunningConfig> {
  const map: Record<string, string | undefined> = {
    'renewal.stk_dunning_enabled': input.enabled === undefined ? undefined : String(input.enabled),
    'renewal.stk_dunning_max_attempts': input.maxAttempts === undefined ? undefined : String(input.maxAttempts),
    'renewal.stk_dunning_window_hours': input.windowHours === undefined ? undefined : String(input.windowHours),
    'renewal.stk_dunning_grace_hours': input.graceHours === undefined ? undefined : String(input.graceHours),
  };
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) continue;
    await query(
      `INSERT INTO settings (key, value, is_secret) VALUES ($1, $2, false)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [k, v]
    );
  }
  return getDunningConfig();
}

export interface DunningTarget {
  service_id: string; plan_id: string; status: string; expiry_date: string;
  phone: string; customer_name: string | null; plan_name: string; price_cents: number;
}

/** Side-effect-free: who would be prompted right now. Drives the preview + sweep. */
export async function dunningTargets(cfg: DunningConfig): Promise<DunningTarget[]> {
  const r = await query<DunningTarget>(
    `SELECT s.id AS service_id, s.plan_id, s.status, s.expiry_date,
            c.phone, c.name AS customer_name, pl.name AS plan_name, pl.price_cents
       FROM services s
       JOIN customers c ON c.id = s.customer_id
       JOIN plans pl ON pl.id = s.plan_id
      WHERE s.service_type = 'pppoe'
        AND s.auto_renew = FALSE
        AND c.phone IS NOT NULL AND c.phone <> ''
        AND pl.price_cents > 0
        AND s.stk_dun_attempts < $1
        AND (s.last_stk_dun_at IS NULL OR s.last_stk_dun_at < now() - ($4 || ' hours')::interval)
        AND (
          (s.status = 'active'  AND s.expiry_date > now() AND s.expiry_date < now() + ($2 || ' hours')::interval)
          OR (s.status = 'expired' AND s.expiry_date > now() - ($3 || ' hours')::interval)
        )
      ORDER BY s.expiry_date
      LIMIT 200`,
    [cfg.maxAttempts, String(cfg.windowHours), String(cfg.graceHours), String(REPROMPT_COOLDOWN_HOURS)]
  );
  return r.rows;
}

export interface DunningRunResult { enabled: boolean; fired: number; eligible: number; skipped?: string }

/** Fire an STK renewal prompt to each eligible customer. Marks each BEFORE firing. */
export async function runStkDunningOnce(): Promise<DunningRunResult> {
  const cfg = await getDunningConfig();
  if (!cfg.enabled) return { enabled: false, fired: 0, eligible: 0 };
  if (await isMpesaSimulated()) {
    return { enabled: true, fired: 0, eligible: 0, skipped: 'M-Pesa STK not configured — prompts cannot be sent' };
  }
  const targets = await dunningTargets(cfg);
  let fired = 0;
  for (const t of targets) {
    // Mark first so a hung STK call can never re-fire this service in a tight loop.
    await query(
      `UPDATE services SET stk_dun_attempts = stk_dun_attempts + 1, last_stk_dun_at = now() WHERE id = $1`,
      [t.service_id]
    );
    try {
      await renew.pay({ planId: t.plan_id, phone: t.phone, serviceId: t.service_id });
      fired++;
    } catch (e) {
      console.error('[stk-dunning] fire failed for service', t.service_id, (e as Error).message);
    }
  }
  return { enabled: true, fired, eligible: targets.length };
}
