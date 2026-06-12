/**
 * Kopo Kopo (K2) adapter — collect M-Pesa via STK ("Receive Payments") without
 * your own Daraja paybill; funds settle to your K2 till/bank. We OAuth with the
 * tenant's client credentials, fire an STK with our HUB reference in metadata,
 * and K2 calls our webhook back with the result — mapped into the SAME
 * settlement engine as C2B / IntaSend / Jenga (reference match -> grant).
 *
 * The STK request carries a per-tenant callback_url (the tenant's own host) so
 * the webhook lands on the right tenant and Host->tenant routing settles it in
 * the correct database.
 */
import { getKopokopoConfig, type KopokopoConfig } from '../settings/service.js';
import { initC2bPurchase, handleC2bConfirmation, type C2bConfirmation } from './c2b.js';
import { normalizeMsisdn } from './daraja.js';
import { badRequest } from '../../lib/errors.js';

const BASE: Record<string, string> = {
  sandbox: 'https://sandbox.kopokopo.com',
  live: 'https://api.kopokopo.com',
};

export interface KopokopoPurchaseResult {
  checkoutRequestId: string;
  amountKes: number;
  simulated: boolean;
  customerMessage: string;
}

async function oauthToken(cfg: KopokopoConfig): Promise<string> {
  const base = BASE[cfg.env] ?? BASE.sandbox;
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error('[kopokopo] auth failed', res.status, JSON.stringify(body));
    throw badRequest(`Kopo Kopo auth failed (${res.status})`);
  }
  return body.access_token as string;
}

async function initStk(cfg: KopokopoConfig, token: string, input: {
  phone: string; amountKes: number; apiRef: string; callbackUrl: string;
}): Promise<void> {
  const base = BASE[cfg.env] ?? BASE.sandbox;
  const res = await fetch(`${base}/api/v1/incoming_payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_channel: 'M-PESA STK Push',
      till_number: cfg.tillNumber,
      subscriber: { phone_number: input.phone },
      amount: { currency: 'KES', value: String(input.amountKes) },
      metadata: { reference: input.apiRef },
      _links: { callback_url: input.callbackUrl },
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('[kopokopo] stk failed', res.status, JSON.stringify(body));
    throw badRequest(`Kopo Kopo STK push failed (${res.status})`);
  }
  console.log('[kopokopo] stk ok', res.headers.get('location') ?? '');
}

/** Create a pending purchase (HUB reference) + fire a Kopo Kopo STK prompt. */
export async function initKopokopoPurchase(
  input: { planId: string; phone: string; mac?: string; userAgent?: string },
  callbackBase: string
): Promise<KopokopoPurchaseResult> {
  const cfg = await getKopokopoConfig();
  if (!cfg.clientId || !cfg.clientSecret) throw badRequest('Kopo Kopo not configured — add your API keys in Settings');
  if (!cfg.tillNumber) throw badRequest('Kopo Kopo till number not set in Settings');

  const base = await initC2bPurchase(input);
  const token = await oauthToken(cfg);
  await initStk(cfg, token, {
    phone: normalizeMsisdn(input.phone),
    amountKes: base.amountKes,
    apiRef: base.checkoutRequestId,
    callbackUrl: `${callbackBase}/api/payments/kopokopo/webhook`,
  });
  return {
    checkoutRequestId: base.checkoutRequestId,
    amountKes: base.amountKes,
    simulated: false,
    customerMessage: `STK push sent to ${input.phone}. Enter your M-Pesa PIN to pay KES ${base.amountKes}.`,
  };
}

/** Handle a Kopo Kopo incoming-payment result webhook. On 'Received' map into
 *  the shared settlement; ack (no grant) on any other status. */
export async function handleKopokopoWebhook(p: any): Promise<{ ok: boolean; note: string }> {
  console.log('[kopokopo-webhook] raw:', JSON.stringify(p));
  const attr = p?.data?.attributes ?? {};
  const status = String(attr.status ?? '').toLowerCase();
  if (status !== 'received') return { ok: true, note: `ignored status=${attr.status ?? 'none'}` };

  const resource = attr.event?.resource ?? {};
  const mapped: C2bConfirmation = {
    TransID: String(resource.reference ?? p?.data?.id ?? ''),      // M-Pesa code = idempotency key
    TransAmount: resource.amount ?? 0,
    BillRefNumber: String(attr.metadata?.reference ?? ''),         // our HUB reference
    MSISDN: String(resource.sender_phone_number ?? ''),
  };
  const r = await handleC2bConfirmation(mapped);
  console.log(`[kopokopo-webhook] ref=${attr.metadata?.reference} amount=${resource.amount} -> ${r.note}`);
  return { ok: r.matched, note: r.note };
}
