import { pool, poolForConnString } from '../../db/pool.js';
import { conflict } from '../../lib/errors.js';
import type { Tenant } from '../tenants/service.js';

// ---------------------------------------------------------------------------
// Shared-callback routing: paybill/till -> tenant. Lives in the CONTROL DB so a
// single HubNet callback URL can resolve which tenant a C2B confirmation belongs
// to (by the receiving shortcode) and settle it in that tenant's database.
// ---------------------------------------------------------------------------

export type PaybillKind = 'paybill' | 'till' | 'bank';

/** Register (or re-affirm) a collection target for a tenant.
 *
 *  paybill / till — the ISP owns a unique Safaricom shortcode; that shortcode is
 *  the routing key and may belong to only one ISP.
 *  bank — the paybill is SHARED (e.g. Equity 247247); the routing key is the
 *  ISP's own `accountNo`, which the customer types as the M-Pesa account and the
 *  bank's IPN echoes back. Two ISPs may share the paybill but never an account.
 *  Rejects a key already owned by a DIFFERENT tenant. */
export async function registerPaybill(
  shortcode: string, tenantId: string, kind: PaybillKind, accountNo?: string
): Promise<void> {
  const code = (shortcode ?? '').trim();

  if (kind === 'bank') {
    const acct = (accountNo ?? '').trim();
    if (!acct) return; // nothing to route on until the ISP gives their account no
    const existing = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_paybill WHERE kind = 'bank' AND account_no = $1`, [acct]
    );
    if (existing.rowCount && existing.rows[0].tenant_id !== tenantId) {
      throw conflict(`bank account ${acct} is already registered to another ISP`);
    }
    await pool.query(
      `INSERT INTO tenant_paybill (shortcode, account_no, tenant_id, kind)
       VALUES ($1, $2, $3, 'bank')
       ON CONFLICT (account_no) WHERE kind = 'bank' AND account_no IS NOT NULL
       DO UPDATE SET shortcode = EXCLUDED.shortcode, tenant_id = EXCLUDED.tenant_id, updated_at = now()
         WHERE tenant_paybill.tenant_id = EXCLUDED.tenant_id`,
      [code, acct, tenantId]
    );
    return;
  }

  if (!code) return;
  const existing = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_paybill WHERE kind <> 'bank' AND shortcode = $1`, [code]
  );
  if (existing.rowCount && existing.rows[0].tenant_id !== tenantId) {
    throw conflict(`shortcode ${code} is already registered to another ISP`);
  }
  await pool.query(
    `INSERT INTO tenant_paybill (shortcode, tenant_id, kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (shortcode) WHERE kind <> 'bank'
     DO UPDATE SET kind = EXCLUDED.kind, updated_at = now()
       WHERE tenant_paybill.tenant_id = EXCLUDED.tenant_id`,
    [code, tenantId, kind]
  );
}

/** Remove a tenant's claim on a non-bank shortcode (e.g. when they switch it). */
export async function unregisterPaybill(shortcode: string, tenantId: string): Promise<void> {
  const code = (shortcode ?? '').trim();
  if (!code) return;
  await pool.query(`DELETE FROM tenant_paybill WHERE shortcode = $1 AND tenant_id = $2 AND kind <> 'bank'`, [code, tenantId]);
}

/** Remove a tenant's claim on a bank account number (the bank routing key). */
export async function unregisterBankAccount(accountNo: string, tenantId: string): Promise<void> {
  const acct = (accountNo ?? '').trim();
  if (!acct) return;
  await pool.query(`DELETE FROM tenant_paybill WHERE account_no = $1 AND tenant_id = $2 AND kind = 'bank'`, [acct, tenantId]);
}

/** Resolve the tenant that owns an own Safaricom `shortcode` (paybill/till), with
 *  its billing pool ready to bind. Bank rows are routed by account number, not
 *  here — see resolveBankAccount. */
export async function resolvePaybill(shortcode: string): Promise<Tenant | null> {
  const code = (shortcode ?? '').trim();
  if (!code) return null;
  const r = await pool.query<Tenant>(
    `SELECT t.id, t.slug, t.name, t.db_conn_string, t.status
       FROM tenant_paybill p JOIN tenant t ON t.id = p.tenant_id
      WHERE p.shortcode = $1 AND p.kind <> 'bank'`,
    [code]
  );
  return r.rows[0] ?? null;
}

/** Resolve the tenant that owns a bank `accountNo` (the shared-paybill routing
 *  key). The bank's IPN carries the destination account; we match it here. */
export async function resolveBankAccount(accountNo: string): Promise<Tenant | null> {
  const acct = (accountNo ?? '').trim();
  if (!acct) return null;
  const r = await pool.query<Tenant>(
    `SELECT t.id, t.slug, t.name, t.db_conn_string, t.status
       FROM tenant_paybill p JOIN tenant t ON t.id = p.tenant_id
      WHERE p.account_no = $1 AND p.kind = 'bank'`,
    [acct]
  );
  return r.rows[0] ?? null;
}

/** The billing pool for a resolved tenant (own DB, or control/default pool). */
export function poolForResolved(t: Tenant) {
  return t.db_conn_string ? poolForConnString(t.db_conn_string) : pool;
}
