import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { getMpesaConfig } from '../settings/service.js';
import { normalizeMsisdn } from './daraja.js';
import { completePurchase } from '../hotspot/service.js';
import { badRequest, notFound } from '../../lib/errors.js';

/**
 * C2B (Customer-to-Business) flow for a Safaricom Paybill you OWN.
 * The customer pays "Pay Bill -> <shortcode> -> Account = <their phone>", and
 * Safaricom POSTs a confirmation to us. We match by the account-ref (phone) +
 * amount to a pending hotspot purchase and settle it (same path as STK). No STK
 * prompt needed; the account number is the join key.
 */

export interface C2bPurchaseResult {
  checkoutRequestId: string;
  amountKes: number;
  payInstructions: { method: 'paybill'; paybill: string; account: string; amountKes: number };
  customerMessage: string;
}

/** Create a PENDING purchase keyed by phone, return the pay-bill instructions. */
export async function initC2bPurchase(input: {
  planId: string; phone: string; mac?: string; userAgent?: string;
}): Promise<C2bPurchaseResult> {
  const pr = await query<{ id: string; name: string; price_cents: number }>(
    `SELECT id, name, price_cents FROM plans WHERE id=$1 AND active=TRUE`,
    [input.planId]
  );
  const plan = pr.rows[0];
  if (!plan) throw notFound('plan');
  if (plan.price_cents <= 0) throw badRequest('plan is free — use voucher flow');
  const phone = normalizeMsisdn(input.phone);
  if (!/^254\d{9}$/.test(phone)) throw badRequest('invalid phone');
  const amountKes = Math.round(plan.price_cents / 100);
  const mp = await getMpesaConfig();
  const checkoutRequestId = 'C2B-' + crypto.randomBytes(8).toString('hex').toUpperCase();
  await query(
    `INSERT INTO hotspot_purchases
       (checkout_request_id, plan_id, phone, mac_address, amount_kes, status, user_agent)
     VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
    [checkoutRequestId, plan.id, phone, input.mac ?? null, amountKes, input.userAgent ?? null]
  );
  return {
    checkoutRequestId,
    amountKes,
    payInstructions: { method: 'paybill', paybill: mp.shortcode, account: phone, amountKes },
    customerMessage: `Lipa na M-Pesa → Pay Bill → ${mp.shortcode} → Account ${phone} → KES ${amountKes}`,
  };
}

export interface C2bConfirmation {
  TransID?: string;
  TransAmount?: string | number;
  MSISDN?: string;
  BillRefNumber?: string;
  BusinessShortCode?: string;
}

/** Handle a Daraja C2B confirmation: dedupe on TransID, match a pending purchase
 * by account-ref (phone) or payer MSISDN + amount, settle it (grant via the
 * existing completePurchase path). Always safe to ACK 0 to Safaricom. */
export async function handleC2bConfirmation(p: C2bConfirmation): Promise<{ matched: boolean; note: string }> {
  const transId = String(p.TransID ?? '').trim();
  const amount = Math.round(Number(p.TransAmount));
  const billRef = normalizeMsisdn(String(p.BillRefNumber ?? ''));
  const msisdn = normalizeMsisdn(String(p.MSISDN ?? ''));
  if (!transId || !Number.isFinite(amount) || amount <= 0) {
    return { matched: false, note: 'missing TransID/amount' };
  }
  // Dedupe — this TransID already recorded as a receipt.
  const dup = await query(`SELECT 1 FROM hotspot_purchases WHERE receipt=$1 LIMIT 1`, [transId]);
  if (dup.rowCount) return { matched: true, note: 'duplicate, ignored' };

  // Match most-recent pending purchase for this phone (account or payer) + amount.
  const m = await query<{ checkout_request_id: string }>(
    `SELECT checkout_request_id FROM hotspot_purchases
      WHERE status='pending' AND amount_kes=$1 AND (phone=$2 OR phone=$3)
      ORDER BY created_at DESC LIMIT 1`,
    [amount, billRef, msisdn]
  );
  const row = m.rows[0];
  if (!row) {
    console.warn(`[c2b] UNMATCHED payment TransID=${transId} amount=${amount} ref=${billRef} msisdn=${msisdn}`);
    return { matched: false, note: 'no pending purchase matched (logged for manual claim)' };
  }
  await completePurchase({ checkoutRequestId: row.checkout_request_id, success: true, receipt: transId });
  return { matched: true, note: 'settled' };
}

/** One-time: register the C2B validation + confirmation URLs with Safaricom. */
export async function registerC2bUrls(): Promise<unknown> {
  const mp = await getMpesaConfig();
  if (!mp.consumerKey || !mp.consumerSecret || !mp.shortcode) {
    throw badRequest('set Consumer Key/Secret + Shortcode first');
  }
  const base = mp.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const auth = Buffer.from(`${mp.consumerKey}:${mp.consumerSecret}`).toString('base64');
  const tokRes = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!tokRes.ok) throw new Error(`Daraja auth failed (${tokRes.status})`);
  const tok = (await tokRes.json() as { access_token: string }).access_token;
  const res = await fetch(`${base}/mpesa/c2b/v1/registerurl`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ShortCode: mp.shortcode,
      ResponseType: 'Completed', // auto-complete if our validation URL is ever unreachable
      ConfirmationURL: `${config.publicApiUrl}/api/payments/c2b/confirmation`,
      ValidationURL: `${config.publicApiUrl}/api/payments/c2b/validation`,
    }),
  });
  return await res.json();
}
