import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { taxOf } from '../../lib/money.js';

export interface TaxRule {
  id: string;
  region: string;
  name: string;
  rate_bps: number;
  active: boolean;
}

/** Active tax rule for a region (defaults to configured region). */
export async function activeRule(region = config.taxRegion): Promise<TaxRule | null> {
  const r = await query<TaxRule>(
    'SELECT * FROM tax_rules WHERE region = $1 AND active = TRUE LIMIT 1',
    [region]
  );
  return r.rows[0] ?? null;
}

/** Compute tax (in cents) and the applied rate for a subtotal. */
export async function computeTax(
  subtotalCents: number,
  region = config.taxRegion
): Promise<{ taxCents: number; rateBps: number; ruleName: string | null }> {
  const rule = await activeRule(region);
  if (!rule) return { taxCents: 0, rateBps: 0, ruleName: null };
  return {
    taxCents: taxOf(subtotalCents, rule.rate_bps),
    rateBps: rule.rate_bps,
    ruleName: rule.name,
  };
}
