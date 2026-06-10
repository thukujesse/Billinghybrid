/**
 * IntaSend aggregator adapter — collect real M-Pesa without your own Daraja
 * paybill. We trigger an STK push via IntaSend (passing our HUB reference as
 * `api_ref`); IntaSend webhooks us the result with that same `api_ref`, which
 * we map into the SAME settlement engine as C2B/Jenga (reference match -> grant).
 * Sandbox lets us run a real end-to-end test (real prompt, real webhook) before
 * going live.
 */
import { getIntasendConfig } from '../settings/service.js';
import { initC2bPurchase, handleC2bConfirmation, type C2bConfirmation } from './c2b.js';
import { normalizeMsisdn } from './daraja.js';
import { badRequest } from '../../lib/errors.js';

const BASE: Record<string, string> = {
  sandbox: 'https://sandbox.intasend.com',
  live: 'https://api.intasend.com',
};

export interface IntasendPurchaseResult {
  checkoutRequestId: string;
  amountKes: number;
  simulated: boolean;
  customerMessage: string;
}

/** Fire an IntaSend M-Pesa STK push with our reference as api_ref. */
async function initStkPush(input: { phone: string; amountKes: number; apiRef: string }): Promise<void> {
  const cfg = await getIntasendConfig();
  if (!cfg.secretKey) throw badRequest('IntaSend not configured — add your Secret key in Settings');
  const base = BASE[cfg.env] ?? BASE.sandbox;
  const res = await fetch(`${base}/api/v1/payment/mpesa-stk-push/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: String(input.amountKes),
      phone_number: input.phone,
      api_ref: input.apiRef,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[intasend] stk push failed', res.status, JSON.stringify(body));
    throw badRequest(`IntaSend STK push failed (${res.status})`);
  }
  console.log('[intasend] stk push ok', JSON.stringify(body));
}

/** Create a pending purchase (HUB reference) + fire the IntaSend STK prompt. */
export async function initIntasendPurchase(input: {
  planId: string; phone: string; mac?: string; userAgent?: string;
}): Promise<IntasendPurchaseResult> {
  // Reuse the C2B pending-row creation so the HUB reference + grant path are identical.
  const base = await initC2bPurchase(input);
  await initStkPush({
    phone: normalizeMsisdn(input.phone),
    amountKes: base.amountKes,
    apiRef: base.checkoutRequestId,
  });
  return {
    checkoutRequestId: base.checkoutRequestId,
    amountKes: base.amountKes,
    simulated: false,
    customerMessage: `STK push sent to ${input.phone}. Enter your M-Pesa PIN to pay KES ${base.amountKes}.`,
  };
}

interface IntasendWebhook {
  invoice_id?: string;
  state?: string;
  value?: string | number;
  account?: string;
  api_ref?: string;
  challenge?: string;
  failed_reason?: string;
}

/** Handle an IntaSend collection webhook: verify the challenge, and on a
 *  COMPLETE state map api_ref -> our reference into the shared settlement. */
export async function handleIntasendWebhook(p: IntasendWebhook): Promise<{ ok: boolean; note: string }> {
  console.log('[intasend-webhook] raw:', JSON.stringify(p));
  const cfg = await getIntasendConfig();
  // The challenge is a secret we set in the IntaSend dashboard; it's echoed in
  // every genuine webhook. Enforce it when configured.
  if (cfg.challenge && p.challenge !== cfg.challenge) {
    console.warn('[intasend-webhook] bad challenge — rejected');
    return { ok: false, note: 'bad challenge' };
  }
  const state = String(p.state ?? '').toUpperCase();
  if (state !== 'COMPLETE') {
    return { ok: true, note: `ignored state=${state}` }; // ack non-final states, don't grant
  }
  const mapped: C2bConfirmation = {
    TransID: String(p.invoice_id ?? ''),        // IntaSend invoice id = idempotency key
    TransAmount: p.value ?? 0,
    BillRefNumber: String(p.api_ref ?? ''),      // our HUB reference
    MSISDN: String(p.account ?? ''),
  };
  const r = await handleC2bConfirmation(mapped);
  console.log(`[intasend-webhook] ref=${p.api_ref} amount=${p.value} invoice=${p.invoice_id} -> ${r.note}`);
  return { ok: r.matched, note: r.note };
}
