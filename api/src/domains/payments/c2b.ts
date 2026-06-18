import crypto from 'node:crypto';
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { getMpesaConfig } from '../settings/service.js';
import { normalizeMsisdn } from './daraja.js';
import { completePurchase } from '../hotspot/service.js';
import { resolveForRouter } from './collectionAccounts.js';
import { initiateBankStk, isBankProvider } from './bankStk.js';
import { recordUnmatched } from './unmatched.js';
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
  // Present when an automated bank STK prompt was fired (provider-backed bank
  // account). The manual payInstructions remain as a fallback.
  stk?: { sent: boolean; simulated: boolean };
}

/** A short, keypad-friendly payment reference the customer types as the Paybill
 *  account number (e.g. HUB458721). Stored as the purchase's checkout_request_id
 *  so it's both the match key (callback BillRefNumber) and the portal poll key.
 *  Unique among pending/recent purchases; retries on the rare collision. */
async function generateReference(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const ref = 'HUB' + String(crypto.randomInt(100000, 1000000));
    const clash = await query(`SELECT 1 FROM hotspot_purchases WHERE checkout_request_id=$1 LIMIT 1`, [ref]);
    if (!clash.rowCount) return ref;
  }
  throw new Error('could not allocate a unique payment reference');
}

/** Create a PENDING purchase, return the pay-bill instructions. The customer
 *  pays "Pay Bill <shortcode>, Account <reference>" and the callback matches
 *  on that reference — robust for a real bank/aggregator (which returns the
 *  typed account ref, not the payer's phone). */
export async function initC2bPurchase(input: {
  planId: string; phone: string; mac?: string; userAgent?: string; nas?: string; slug?: string;
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
  const checkoutRequestId = await generateReference();

  // Resolve which destination collects this payment: the account assigned to the
  // customer's router wins, else the tenant default, else the legacy global
  // M-Pesa config. For a shared BANK paybill (e.g. Equity 247247) the customer
  // types the ISP's bank ACCOUNT NUMBER as the M-Pesa account (that's how the
  // bank routes + how the IPN identifies the tenant; we settle by phone+amount).
  // For paybill/till the account = our HUB reference (matched on BillRefNumber).
  const { account, routerId } = await resolveForRouter({ nas: input.nas, slug: input.slug, globalMethod: mp.collectionMethod });
  let method: 'paybill' | 'till' | 'bank';
  let payNumber: string;
  let displayAccount: string;
  if (account) {
    method = account.method;
    if (method === 'bank') { payNumber = account.paybill; displayAccount = account.account_no || checkoutRequestId; }
    else if (method === 'till') { payNumber = account.till; displayAccount = checkoutRequestId; }
    else { payNumber = account.paybill; displayAccount = checkoutRequestId; }
  } else {
    method = (mp.collectionMethod === 'till' || mp.collectionMethod === 'bank') ? mp.collectionMethod : 'paybill';
    payNumber = method === 'till' ? mp.till : mp.shortcode;
    displayAccount = method === 'bank' && mp.accountNo ? mp.accountNo : checkoutRequestId;
  }

  await query(
    `INSERT INTO hotspot_purchases
       (checkout_request_id, plan_id, phone, mac_address, amount_kes, status, user_agent, router_id, collection_account_id)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
    [checkoutRequestId, plan.id, phone, input.mac ?? null, amountKes, input.userAgent ?? null, routerId, account?.id ?? null]
  );
  const verb = method === 'till' ? 'Buy Goods' : 'Pay Bill';
  const manualMsg = `Lipa na M-Pesa → ${verb} → ${payNumber} → Account ${displayAccount} → KES ${amountKes}`;

  // Automated path: a bank account wired to a bank STK provider (Equity JengaHQ
  // / KCB) fires the prompt straight away, so the customer just enters their PIN
  // and the bank deposits to the ISP's account. The bank's IPN settles via the
  // shared bank-IPN endpoint (routed by account number). Manual instructions
  // stay as a fallback in case the prompt is dismissed.
  if (account && account.method === 'bank' && isBankProvider(account.provider)) {
    const token = config.control.sharedCallbackToken ? `?token=${encodeURIComponent(config.control.sharedCallbackToken)}` : '';
    const callbackUrl = `https://${config.control.sharedPayHost}/api/payments/shared/jenga/ipn${token}`;
    const r = await initiateBankStk(account.provider, {
      env: (account.provider_env === 'live' ? 'live' : 'sandbox'),
      paybill: account.paybill, accountNo: account.account_no,
      phone, amountKes, reference: checkoutRequestId, callbackUrl,
    });
    return {
      checkoutRequestId,
      amountKes,
      payInstructions: { method: 'paybill', paybill: payNumber, account: displayAccount, amountKes },
      customerMessage: r.ok
        ? `${r.message}. Enter your M-Pesa PIN to pay KES ${amountKes}.${r.simulated ? '' : ` (Or pay manually: ${manualMsg})`}`
        : `Could not send the prompt — pay manually: ${manualMsg}`,
      stk: { sent: r.ok, simulated: r.simulated },
    };
  }

  return {
    checkoutRequestId,
    amountKes,
    payInstructions: { method: 'paybill', paybill: payNumber, account: displayAccount, amountKes },
    customerMessage: manualMsg,
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
export async function handleC2bConfirmation(p: C2bConfirmation, source = 'c2b'): Promise<{ matched: boolean; note: string }> {
  const transId = String(p.TransID ?? '').trim();
  const amount = Math.round(Number(p.TransAmount));
  // The account number the payer typed = our generated reference (e.g. HUB458721).
  // Do NOT normalize as a phone — it's an alphanumeric reference.
  const ref = String(p.BillRefNumber ?? '').trim().toUpperCase();
  const msisdn = normalizeMsisdn(String(p.MSISDN ?? ''));
  if (!transId || !Number.isFinite(amount) || amount <= 0) {
    return { matched: false, note: 'missing TransID/amount' };
  }
  // Dedupe — this TransID already recorded as a receipt.
  const dup = await query(`SELECT 1 FROM hotspot_purchases WHERE receipt=$1 LIMIT 1`, [transId]);
  if (dup.rowCount) return { matched: true, note: 'duplicate, ignored' };

  // Primary match: the reference the customer typed as the account number.
  let row = (await query<{ checkout_request_id: string; amount_kes: number }>(
    `SELECT checkout_request_id, amount_kes FROM hotspot_purchases
      WHERE status='pending' AND checkout_request_id = $1 LIMIT 1`,
    [ref]
  )).rows[0];
  // Fallback: legacy phone-as-account (own-Safaricom-Paybill, customer typed their number).
  if (!row) {
    const phoneRef = normalizeMsisdn(ref);
    row = (await query<{ checkout_request_id: string; amount_kes: number }>(
      `SELECT checkout_request_id, amount_kes FROM hotspot_purchases
        WHERE status='pending' AND amount_kes=$1 AND (phone=$2 OR phone=$3)
        ORDER BY created_at DESC LIMIT 1`,
      [amount, phoneRef, msisdn]
    )).rows[0];
  }
  if (!row) {
    console.warn(`[c2b] UNMATCHED payment TransID=${transId} amount=${amount} ref=${ref} msisdn=${msisdn}`);
    await recordUnmatched({ source, transId, amount, msisdn, reference: ref, reason: 'no_match', raw: p });
    return { matched: false, note: 'no pending purchase matched (parked for reconciliation)' };
  }
  // Guard: the payment must cover the package price (no partial activation).
  if (amount < row.amount_kes) {
    console.warn(`[c2b] UNDERPAID ref=${ref} TransID=${transId} paid=${amount} need=${row.amount_kes}`);
    await recordUnmatched({ source, transId, amount, msisdn, reference: ref, reason: 'underpaid', raw: p });
    return { matched: false, note: 'underpaid — not activated' };
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
  // Register the SHARED HubNet callback (routed by shortcode), not a per-host
  // one — so every ISP points at the same URL and we match by their paybill.
  const q = config.control.sharedCallbackToken ? `?token=${encodeURIComponent(config.control.sharedCallbackToken)}` : '';
  const sharedBase = `https://${config.control.sharedPayHost}/api/payments/shared`;
  const res = await fetch(`${base}/mpesa/c2b/v1/registerurl`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ShortCode: mp.shortcode,
      ResponseType: 'Completed', // auto-complete if our validation URL is ever unreachable
      ConfirmationURL: `${sharedBase}/confirmation${q}`,
      ValidationURL: `${sharedBase}/validation${q}`,
    }),
  });
  return await res.json();
}
