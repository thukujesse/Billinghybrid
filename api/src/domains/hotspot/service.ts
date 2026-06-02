import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { config } from '../../config.js';
import { stkPush, normalizeMsisdn, parseCallback } from '../payments/daraja.js';

export interface HotspotGrant {
  /** Username to pass to MikroTik hotspot login (typically = voucher code). */
  username: string;
  /** Password to pass to MikroTik hotspot login (we accept any non-empty). */
  password: string;
  /** Session-Timeout reply attribute, in seconds. */
  validitySeconds: number;
  /** Rate limit string (e.g. "5M/5M") for the customer's link. */
  rateLimit: string | null;
  /** Plan name for friendly UI display. */
  planName: string;
}

/**
 * Voucher-based hotspot grant. Atomically:
 *   1. Mark the voucher used
 *   2. Insert radcheck row keyed by the voucher code (= the username
 *      MikroTik will send in its hotspot Access-Request)
 *   3. Insert radreply rows for Session-Timeout + Mikrotik-Rate-Limit
 * Returns the credentials the portal page will pass back to MikroTik.
 */
export async function redeemVoucher(input: {
  code: string;
  mac?: string;
}): Promise<HotspotGrant> {
  const code = input.code.trim().toUpperCase();
  if (!code) throw badRequest('voucher code required');

  return withTransaction(async (c) => {
    // Lock voucher row + load plan in one go.
    const r = await c.query<{
      voucher_id: string;
      status: string;
      voucher_expires: string | null;
      plan_id: string;
      plan_name: string;
      validity_days: number;
      speed_down_kbps: number | null;
      speed_up_kbps: number | null;
    }>(
      `SELECT v.id AS voucher_id, v.status, v.expires_at AS voucher_expires,
              p.id AS plan_id, p.name AS plan_name, p.validity_days,
              p.speed_down_kbps, p.speed_up_kbps
         FROM vouchers v
         JOIN plans p ON p.id = v.plan_id
        WHERE v.code = $1 FOR UPDATE OF v`,
      [code]
    );
    const voucher = r.rows[0];
    if (!voucher) throw notFound('voucher');
    if (voucher.status !== 'unused') throw conflict(`voucher is ${voucher.status}`);
    if (voucher.voucher_expires && new Date(voucher.voucher_expires) < new Date()) {
      await c.query(`UPDATE vouchers SET status='expired' WHERE id=$1`, [voucher.voucher_id]);
      throw conflict('voucher has expired');
    }

    await c.query(
      `UPDATE vouchers SET status='used', used_at=now() WHERE id=$1`,
      [voucher.voucher_id]
    );

    // Compute reply attributes from the plan.
    const validitySeconds = Math.max(60, voucher.validity_days * 86400);
    const rateLimit = voucher.speed_down_kbps && voucher.speed_up_kbps
      ? `${voucher.speed_up_kbps}k/${voucher.speed_down_kbps}k`
      : null;

    // Insert into FreeRADIUS tables. Username = voucher code; password is the
    // same (hotspot auth doesn't really care, MAC binding via Calling-Station
    // is the real identity in MikroTik's Hotspot flow).
    await c.query(`DELETE FROM radcheck WHERE username=$1`, [code]);
    await c.query(`DELETE FROM radreply WHERE username=$1`, [code]);
    await c.query(
      `INSERT INTO radcheck (username, attribute, op, value)
       VALUES ($1, 'Cleartext-Password', ':=', $1)`,
      [code]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Session-Timeout', ':=', $2)`,
      [code, String(validitySeconds)]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Idle-Timeout', ':=', '600')`,
      [code]
    );
    if (rateLimit) {
      await c.query(
        `INSERT INTO radreply (username, attribute, op, value)
         VALUES ($1, 'Mikrotik-Rate-Limit', '=', $2)`,
        [code, rateLimit]
      );
    }

    return {
      username: code,
      password: code,
      validitySeconds,
      rateLimit,
      planName: voucher.plan_name,
    };
  });
}

export interface PurchaseInitResult {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
}

/**
 * Start an M-Pesa STK push for a hotspot plan. Records a pending purchase
 * row keyed by the checkoutRequestId; the Daraja callback completes it.
 * If credentials aren't configured we run "simulation mode" — return a
 * fake checkoutRequestId the portal can confirm to instantly grant access.
 */
export async function initPurchase(input: {
  planId: string;
  phone: string;
  mac?: string;
}): Promise<PurchaseInitResult> {
  const pr = await query<{
    id: string; name: string; price_cents: number; validity_days: number;
    speed_down_kbps: number | null; speed_up_kbps: number | null;
  }>(
    `SELECT id, name, price_cents, validity_days, speed_down_kbps, speed_up_kbps
       FROM plans WHERE id = $1 AND active = TRUE`,
    [input.planId]
  );
  const plan = pr.rows[0];
  if (!plan) throw notFound('plan');
  if (plan.price_cents <= 0) throw badRequest('plan is free — use voucher flow');

  const phone = normalizeMsisdn(input.phone);
  if (!/^254\d{9}$/.test(phone)) throw badRequest('invalid phone');

  const amountKes = Math.round(plan.price_cents / 100);
  const simulated = config.mpesa.simulated;
  let checkoutRequestId: string;
  let customerMessage: string;

  if (simulated) {
    // No M-Pesa creds — generate a fake checkoutRequestId. Portal can call
    // /confirm-test to mark this purchase successful for end-to-end testing.
    checkoutRequestId = 'SIM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    customerMessage = `[Simulation] Would have charged ${phone} KES ${amountKes}`;
  } else {
    const res = await stkPush({
      phone,
      amountKes,
      accountReference: phone.slice(-9),
      description: plan.name.slice(0, 13),
    });
    checkoutRequestId = res.checkoutRequestId;
    customerMessage = res.customerMessage;
  }

  await query(
    `INSERT INTO hotspot_purchases
       (checkout_request_id, plan_id, phone, mac_address, amount_kes, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [checkoutRequestId, plan.id, phone, input.mac ?? null, amountKes]
  );

  return { checkoutRequestId, amountKes, customerMessage, simulated };
}

export interface PurchaseStatus {
  status: 'pending' | 'success' | 'failed' | 'expired';
  grant?: HotspotGrant;
  failureReason?: string;
}

/** Portal polls this every couple of seconds while STK is in flight. */
export async function getPurchaseStatus(checkoutRequestId: string): Promise<PurchaseStatus> {
  const r = await query<{
    status: 'pending' | 'success' | 'failed' | 'expired';
    username: string | null;
    validity_seconds: number | null;
    rate_limit: string | null;
    plan_name: string;
    failure_reason: string | null;
  }>(
    `SELECT hp.status, hp.username, hp.validity_seconds, hp.rate_limit,
            p.name AS plan_name, hp.failure_reason
       FROM hotspot_purchases hp
       JOIN plans p ON p.id = hp.plan_id
      WHERE hp.checkout_request_id = $1`,
    [checkoutRequestId]
  );
  if (r.rows.length === 0) throw notFound('purchase');
  const row = r.rows[0];

  if (row.status === 'success' && row.username) {
    return {
      status: 'success',
      grant: {
        username: row.username,
        password: row.username,
        validitySeconds: row.validity_seconds ?? 3600,
        rateLimit: row.rate_limit,
        planName: row.plan_name,
      },
    };
  }
  return { status: row.status, failureReason: row.failure_reason ?? undefined };
}

/**
 * Handle a Daraja callback (or our simulation confirmation). On success,
 * finalize the purchase: generate a unique session username, insert
 * radcheck + radreply, mark the purchase successful.
 */
export async function completePurchase(input: {
  checkoutRequestId: string;
  success: boolean;
  receipt?: string;
  failureReason?: string;
}): Promise<void> {
  await withTransaction(async (c) => {
    const r = await c.query<{
      id: string; plan_id: string; phone: string;
      validity_days: number;
      speed_down_kbps: number | null; speed_up_kbps: number | null;
      status: string;
    }>(
      `SELECT hp.id, hp.plan_id, hp.phone, hp.status,
              p.validity_days, p.speed_down_kbps, p.speed_up_kbps
         FROM hotspot_purchases hp
         JOIN plans p ON p.id = hp.plan_id
        WHERE hp.checkout_request_id = $1 FOR UPDATE OF hp`,
      [input.checkoutRequestId]
    );
    const row = r.rows[0];
    if (!row) return; // unknown checkoutRequestId, ignore (might be a non-hotspot payment)
    if (row.status !== 'pending') return; // idempotent — already settled

    if (!input.success) {
      await c.query(
        `UPDATE hotspot_purchases SET status='failed', failure_reason=$2, completed_at=now()
          WHERE id=$1`,
        [row.id, input.failureReason ?? 'STK push rejected']
      );
      return;
    }

    // Success: generate session credentials + radcheck/radreply.
    const username = 'hs-' + crypto.randomBytes(4).toString('hex');
    const validitySeconds = Math.max(60, row.validity_days * 86400);
    const rateLimit = row.speed_down_kbps && row.speed_up_kbps
      ? `${row.speed_up_kbps}k/${row.speed_down_kbps}k`
      : null;

    await c.query(
      `INSERT INTO radcheck (username, attribute, op, value)
       VALUES ($1, 'Cleartext-Password', ':=', $1)`,
      [username]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Session-Timeout', ':=', $2)`,
      [username, String(validitySeconds)]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Idle-Timeout', ':=', '600')`,
      [username]
    );
    if (rateLimit) {
      await c.query(
        `INSERT INTO radreply (username, attribute, op, value)
         VALUES ($1, 'Mikrotik-Rate-Limit', '=', $2)`,
        [username, rateLimit]
      );
    }
    await c.query(
      `UPDATE hotspot_purchases
          SET status='success', username=$2, validity_seconds=$3,
              rate_limit=$4, receipt=$5, completed_at=now()
        WHERE id=$1`,
      [row.id, username, validitySeconds, rateLimit, input.receipt ?? null]
    );
  });
}

/** Dispatch a Daraja callback (called by the public callback endpoint). */
export async function handleDarajaCallback(body: unknown): Promise<boolean> {
  const parsed = parseCallback(body);
  if (!parsed) return false;
  await completePurchase({
    checkoutRequestId: parsed.checkoutRequestId,
    success: parsed.success,
    receipt: parsed.receipt,
    failureReason: parsed.success ? undefined : 'M-Pesa declined or cancelled',
  });
  return true;
}

