/**
 * Customer wallet (PPPoE / hotspot track) — separate from the legacy
 * `domains/wallet/service.ts` which serves the subscriber model. We
 * keep them apart because the storage tables, owner identity, and
 * top-up callback paths are all different.
 *
 * Concurrency model: balance updates use an atomic `UPDATE balance =
 * balance + $2` with a DB-level `CHECK >= 0` so concurrent debits can't
 * double-spend and can't take the balance negative. Read-modify-write
 * with serializable isolation would be heavier and is unnecessary here.
 */
import { query, withTransaction } from '../../db/pool.js';
import type { PoolClient } from 'pg';
import { badRequest, notFound, conflict } from '../../lib/errors.js';
import { config } from '../../config.js';
import { normalizeMsisdn, stkPush } from '../payments/daraja.js';
import crypto from 'node:crypto';

export interface Wallet {
  customer_id: string;
  balance_cents: number;
  updated_at: string;
}

export interface WalletTxn {
  id: string;
  customer_id: string;
  kind: 'topup' | 'renewal_debit' | 'adjustment' | 'refund';
  amount_cents: number;
  balance_after_cents: number;
  reference: string | null;
  service_id: string | null;
  purchase_id: string | null;
  notes: string | null;
  actor: string;
  created_at: string;
}

export async function getWallet(customerId: string): Promise<Wallet> {
  // Auto-create the wallet row on first read so portal /me always returns
  // a balance (zero for fresh customers).
  const r = await query<Wallet>(
    `INSERT INTO customer_wallets (customer_id, balance_cents)
     VALUES ($1, 0)
     ON CONFLICT (customer_id) DO UPDATE SET customer_id = EXCLUDED.customer_id
     RETURNING customer_id, balance_cents, updated_at`,
    [customerId]
  );
  return { ...r.rows[0], balance_cents: Number(r.rows[0].balance_cents) };
}

export async function listTxns(customerId: string, limit = 50): Promise<WalletTxn[]> {
  const cap = Math.min(Math.max(limit, 1), 500);
  const r = await query<WalletTxn>(
    `SELECT * FROM customer_wallet_txns
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [customerId, cap]
  );
  return r.rows.map((row) => ({
    ...row,
    amount_cents: Number(row.amount_cents),
    balance_after_cents: Number(row.balance_after_cents),
  }));
}

interface AdjustInput {
  customerId: string;
  amountCents: number;        // positive credit, negative debit
  kind: WalletTxn['kind'];
  reference?: string | null;
  serviceId?: string | null;
  purchaseId?: string | null;
  notes?: string | null;
  actor?: string;
}

/** The atomic credit-or-debit primitive — UPDATE + INSERT in one tx. */
async function applyTxnInTx(c: PoolClient, input: AdjustInput): Promise<WalletTxn> {
  if (input.amountCents === 0) throw badRequest('amount cannot be zero');
  await c.query(
    `INSERT INTO customer_wallets (customer_id, balance_cents)
     VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [input.customerId]
  );
  let balanceAfter: number;
  try {
    const upd = await c.query<{ balance_cents: string }>(
      `UPDATE customer_wallets
          SET balance_cents = balance_cents + $2, updated_at = now()
        WHERE customer_id = $1
        RETURNING balance_cents`,
      [input.customerId, input.amountCents]
    );
    if (!upd.rows[0]) throw notFound('wallet');
    balanceAfter = Number(upd.rows[0].balance_cents);
  } catch (err: any) {
    // 23514 = check constraint violation (balance < 0)
    if (err?.code === '23514') throw conflict('insufficient wallet balance');
    throw err;
  }
  const ins = await c.query<WalletTxn>(
    `INSERT INTO customer_wallet_txns
       (customer_id, kind, amount_cents, balance_after_cents,
        reference, service_id, purchase_id, notes, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.customerId, input.kind, input.amountCents, balanceAfter,
      input.reference ?? null, input.serviceId ?? null,
      input.purchaseId ?? null, input.notes ?? null,
      input.actor ?? 'system',
    ]
  );
  return {
    ...ins.rows[0],
    amount_cents: Number(ins.rows[0].amount_cents),
    balance_after_cents: Number(ins.rows[0].balance_after_cents),
  };
}

export async function applyTxn(input: AdjustInput): Promise<WalletTxn> {
  return withTransaction((c) => applyTxnInTx(c, input));
}
export const applyTxnInTransaction = applyTxnInTx;

// =====================================================================
// M-Pesa top-up flow
// =====================================================================

export interface TopupInitResult {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
}

/**
 * Trigger an M-Pesa STK push that on success credits the customer's
 * wallet rather than activating a specific service. The
 * `wallet_topup_customer_id` column on hotspot_purchases lets the
 * shared callback handler distinguish wallet top-ups from renewals
 * from guest hotspot grants.
 */
export async function initWalletTopup(input: {
  customerId: string;
  amountKes: number;
  phone: string;
}): Promise<TopupInitResult> {
  if (!Number.isFinite(input.amountKes) || input.amountKes < 10) {
    throw badRequest('minimum top-up is KES 10');
  }
  if (input.amountKes > 70000) {
    throw badRequest('per-transaction M-Pesa limit is KES 70,000');
  }
  const phone = normalizeMsisdn(input.phone);
  if (!/^254\d{9}$/.test(phone)) throw badRequest('invalid phone');

  const simulated = config.mpesa.simulated;
  let checkoutRequestId: string;
  let customerMessage: string;

  if (simulated) {
    checkoutRequestId = 'SIM-WALLET-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    customerMessage = `[Simulation] Would have credited wallet KES ${input.amountKes}`;
  } else {
    const res = await stkPush({
      phone,
      amountKes: input.amountKes,
      accountReference: phone.slice(-9),
      description: `Wallet topup`.slice(0, 13),
    });
    checkoutRequestId = res.checkoutRequestId;
    customerMessage = res.customerMessage;
  }

  // plan_id is NOT NULL on hotspot_purchases. Use cheapest active plan as a
  // placeholder — wallet_topup_customer_id is what actually routes the
  // callback to creditWalletFromPurchase rather than service activation.
  const ph = await query<{ id: string }>(
    `SELECT id FROM plans WHERE active = TRUE ORDER BY price_cents ASC LIMIT 1`
  );
  if (!ph.rows[0]) throw badRequest('no active plans configured — needed as placeholder for wallet topup');

  await query(
    `INSERT INTO hotspot_purchases
       (checkout_request_id, plan_id, phone, amount_kes, status, wallet_topup_customer_id)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [checkoutRequestId, ph.rows[0].id, phone, input.amountKes, input.customerId]
  );

  return { checkoutRequestId, amountKes: input.amountKes, customerMessage, simulated };
}

/**
 * Called from hotspot.completePurchase when a successful purchase row has
 * wallet_topup_customer_id set. Idempotent — skips if a txn with the
 * same purchase_id already exists, so duplicate Daraja callbacks can't
 * double-credit.
 */
export async function creditWalletFromPurchase(input: {
  customerId: string;
  amountKes: number;
  purchaseId: string;
  receipt: string | null;
}): Promise<WalletTxn | null> {
  const txn = await withTransaction(async (c) => {
    const dupe = await c.query(
      `SELECT 1 FROM customer_wallet_txns WHERE purchase_id = $1 AND kind = 'topup'`,
      [input.purchaseId]
    );
    if (dupe.rowCount && dupe.rowCount > 0) return null;
    return applyTxnInTx(c, {
      customerId: input.customerId,
      amountCents: input.amountKes * 100,
      kind: 'topup',
      reference: input.receipt,
      purchaseId: input.purchaseId,
      actor: 'mpesa',
    });
  });
  // SMS confirmation only for fresh credits (txn !== null) — duplicate
  // Daraja callbacks return null and we don't double-text. Dynamic import
  // breaks the circular dependency between wallet ↔ notifications.
  if (txn) {
    const { sendWalletToppedUp } = await import('./notifications.js');
    sendWalletToppedUp({
      customerId: input.customerId,
      amountKes: input.amountKes,
      balanceCents: txn.balance_after_cents,
      purchaseId: input.purchaseId,
      receipt: input.receipt,
    }).catch((e) => console.error('[topup-sms]', (e as Error).message));
  }
  return txn;
}

/**
 * Try to renew a service from wallet balance. Used both by:
 *   - portal "Renew from wallet" button (customer-initiated)
 *   - expire-worker auto-renew sweep (system-initiated, opt-in via auto_renew)
 *
 * All-or-nothing: debit + extend expiry happen in a single transaction
 * so a mid-flight crash can't leave us with money taken but service not
 * renewed (or vice versa).
 */
export async function renewServiceFromWallet(input: {
  customerId: string;
  serviceId: string;
  actor: string;       // 'system' for auto-renew worker, customer id for portal
}): Promise<{ txn: WalletTxn; new_expiry: string }> {
  return withTransaction(async (c) => {
    // 1. Load service + plan + verify ownership
    const sr = await c.query<{
      id: string; customer_id: string; plan_id: string | null;
      expiry_date: string | null; status: string; username: string | null;
      price_cents: number | null; validity_days: number | null;
      speed_down_kbps: number | null; speed_up_kbps: number | null;
    }>(
      `SELECT s.id, s.customer_id, s.plan_id, s.expiry_date, s.status, s.username,
              p.price_cents, p.validity_days, p.speed_down_kbps, p.speed_up_kbps
         FROM services s
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.id = $1`,
      [input.serviceId]
    );
    const svc = sr.rows[0];
    if (!svc) throw notFound('service');
    if (svc.customer_id !== input.customerId) throw badRequest('service does not belong to this customer');
    if (!svc.plan_id || !svc.price_cents || !svc.validity_days) {
      throw badRequest('service has no plan — set one via /services/:id/plan first');
    }

    // 2. Debit the wallet — throws conflict('insufficient wallet balance')
    //    if there isn't enough, which the API surfaces as 409 to the caller.
    const txn = await applyTxnInTx(c, {
      customerId: input.customerId,
      amountCents: -svc.price_cents,
      kind: 'renewal_debit',
      reference: `service ${svc.username}`,
      serviceId: svc.id,
      notes: `Renewal · ${svc.validity_days}d`,
      actor: input.actor,
    });

    // 3. Extend expiry. Stack onto existing expiry if the service is still
    //    live (loyal customer); restart the window if expired or cancelled.
    const base = (svc.expiry_date && new Date(svc.expiry_date) > new Date() && svc.status === 'active')
      ? new Date(svc.expiry_date)
      : new Date();
    const newExpiry = new Date(base);
    newExpiry.setDate(newExpiry.getDate() + svc.validity_days);

    const rateLimit = (svc.speed_down_kbps && svc.speed_up_kbps)
      ? `${svc.speed_up_kbps}k/${svc.speed_down_kbps}k`
      : null;

    await c.query(
      `UPDATE services
          SET expiry_date = $2, rate_limit = COALESCE($3, rate_limit),
              expiry_warned_at = NULL, updated_at = now()
        WHERE id = $1`,
      [svc.id, newExpiry.toISOString(), rateLimit]
    );

    return { txn, new_expiry: newExpiry.toISOString() };
  });
}

/**
 * Sweep services with active=true, auto_renew=true, expiry within N hours,
 * and a wallet balance >= plan price. Debits + renews + logs. Used by the
 * expire worker BEFORE it sends warning SMS — customers who can auto-renew
 * never see the "expiring soon" notification because they don't need to act.
 *
 * Returns the list of services that were successfully auto-renewed so the
 * worker can log them.
 */
export async function autoRenewDue(windowHours = 24): Promise<Array<{
  service_id: string; customer_id: string; new_expiry: string; amount_cents: number;
}>> {
  const r = await query<{
    service_id: string; customer_id: string; price_cents: number;
  }>(
    `SELECT s.id AS service_id, s.customer_id, p.price_cents
       FROM services s
       JOIN plans p ON p.id = s.plan_id
       JOIN customer_wallets w ON w.customer_id = s.customer_id
      WHERE s.service_type = 'pppoe'
        AND s.status = 'active'
        AND s.auto_renew = TRUE
        AND s.expiry_date IS NOT NULL
        AND s.expiry_date > now()
        AND s.expiry_date < now() + ($1 || ' hours')::interval
        AND w.balance_cents >= p.price_cents`,
    [String(windowHours)]
  );
  const out: Array<{ service_id: string; customer_id: string; new_expiry: string; amount_cents: number }> = [];
  // Dynamic import to avoid the wallet ↔ notifications cycle.
  const { sendAutoRenewed } = await import('./notifications.js');
  for (const row of r.rows) {
    try {
      const result = await renewServiceFromWallet({
        customerId: row.customer_id,
        serviceId: row.service_id,
        actor: 'auto-renew-worker',
      });
      out.push({
        service_id: row.service_id,
        customer_id: row.customer_id,
        new_expiry: result.new_expiry,
        amount_cents: Number(row.price_cents),
      });
      // Confirm to the customer that we silently renewed for them. Name
      // resolution does an extra query — fine at sweep-batch size; if this
      // ever sweeps thousands we'd join in the SELECT above instead.
      const meta = await query<{ service_name: string; balance_cents: string }>(
        `SELECT COALESCE(p.name, s.username, 'your plan') AS service_name,
                w.balance_cents::text
           FROM services s
           LEFT JOIN plans p ON p.id = s.plan_id
           LEFT JOIN customer_wallets w ON w.customer_id = s.customer_id
          WHERE s.id = $1`,
        [row.service_id]
      );
      if (meta.rows[0]) {
        sendAutoRenewed({
          customerId: row.customer_id,
          serviceId: row.service_id,
          serviceName: meta.rows[0].service_name,
          newExpiry: result.new_expiry,
          amountKes: Math.round(Number(row.price_cents) / 100),
          balanceCents: Number(meta.rows[0].balance_cents) || 0,
        }).catch((e) => console.error('[auto-renew-sms]', (e as Error).message));
      }
    } catch (err) {
      console.error('[auto-renew] failed for service', row.service_id, (err as Error).message);
    }
  }
  return out;
}

export async function setAutoRenew(serviceId: string, customerId: string, autoRenew: boolean): Promise<void> {
  const r = await query(
    `UPDATE services SET auto_renew = $2, updated_at = now()
      WHERE id = $1 AND customer_id = $3`,
    [serviceId, autoRenew, customerId]
  );
  if (r.rowCount === 0) throw notFound('service');
}
