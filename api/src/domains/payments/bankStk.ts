import { query } from '../../db/pool.js';

/**
 * Automated bank STK Push — fire the M-Pesa prompt through a BANK's own STK API
 * (Equity JengaHQ, KCB Buni, ...) so funds land DIRECTLY in the ISP's bank
 * account (matched by account number). The bank holds the Safaricom paybill +
 * Daraja relationship; the ISP supplies their account number and the platform
 * holds the bank's merchant API credentials.
 *
 * Built defensively, exactly like the inbound jenga.ts adapter: the live request
 * shapes/signatures differ per bank + per onboarding, so every call is logged
 * and a SIMULATE fallback runs whenever credentials are absent (or
 * BANK_STK_SIMULATION=true) — the full portal -> prompt -> settle -> auto-connect
 * flow works today, and going live is "drop in the credentials + confirm the
 * field mapping on the first real call".
 */

export type BankProvider = 'equity_jenga' | 'kcb';
export const BANK_PROVIDERS: BankProvider[] = ['equity_jenga', 'kcb'];
export function isBankProvider(s: string): s is BankProvider {
  return s === 'equity_jenga' || s === 'kcb';
}

export interface BankStkRequest {
  env: 'sandbox' | 'live';
  paybill: string;     // bank paybill (e.g. Equity 247247 / KCB 522522)
  accountNo: string;   // the ISP's bank account number — the deposit target
  phone: string;       // 2547XXXXXXXX
  amountKes: number;
  reference: string;   // our HUB ref — passed as the bank invoice/account ref so the IPN echoes it
  callbackUrl: string; // where the bank posts its payment notification
}
export interface BankStkResult {
  ok: boolean;
  providerRef?: string; // the bank's transaction / checkout id
  message: string;      // customer-facing
  simulated: boolean;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Credentials — per-tenant-per-provider, in the `settings` table (write-only
// secrets, same pattern as IntaSend/Kopo Kopo). Stored under bankstk.<provider>.*
// ---------------------------------------------------------------------------
const SECRET_FIELDS = new Set(['consumer_key', 'consumer_secret', 'api_key', 'signing_key']);
const FIELD_MAP: Record<string, string> = {
  merchantCode: 'merchant_code',
  consumerKey: 'consumer_key',
  consumerSecret: 'consumer_secret',
  apiKey: 'api_key',
  signingKey: 'signing_key',
};

async function readCreds(p: BankProvider): Promise<Record<string, string>> {
  const prefix = `bankstk.${p}.`;
  const r = await query<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key LIKE $1`, [`${prefix}%`]);
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.key.slice(prefix.length)] = row.value;
  return out;
}

/** What credentials a provider needs to be "live" (else we simulate). */
function configured(p: BankProvider, c: Record<string, string>): boolean {
  if (p === 'equity_jenga') return !!(c.merchant_code && c.consumer_secret && c.api_key);
  if (p === 'kcb') return !!(c.api_key || (c.consumer_key && c.consumer_secret));
  return false;
}

export async function getBankProviderPublic(p: BankProvider) {
  const c = await readCreds(p);
  return {
    provider: p,
    merchantCode: c.merchant_code ?? '',
    consumerKeySet: !!c.consumer_key,
    consumerSecretSet: !!c.consumer_secret,
    apiKeySet: !!c.api_key,
    signingKeySet: !!c.signing_key,
    configured: configured(p, c),
  };
}

export async function setBankProvider(
  p: BankProvider, input: Record<string, string | undefined>, updatedBy?: string
): Promise<void> {
  for (const [camel, col] of Object.entries(FIELD_MAP)) {
    const v = input[camel];
    if (v === undefined) continue;
    const key = `bankstk.${p}.${col}`;
    const value = v.trim();
    if (value === '') {
      await query(`DELETE FROM settings WHERE key = $1`, [key]);
    } else {
      await query(
        `INSERT INTO settings (key, value, is_secret, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, is_secret=EXCLUDED.is_secret, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [key, value, SECRET_FIELDS.has(col), updatedBy ?? 'admin']
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Adapters — one per bank. Each turns our generic request into the bank's STK
// call. Endpoints/fields are coded to the published spec and ALWAYS logged so
// the first live transaction confirms the exact shape (same approach as the
// inbound Jenga handler). Verify against your bank's live docs before go-live.
// ---------------------------------------------------------------------------
interface Adapter { initiate(creds: Record<string, string>, req: BankStkRequest): Promise<BankStkResult>; }

const equityJenga: Adapter = {
  async initiate(creds, req) {
    const base = req.env === 'live' ? 'https://api.finserve.africa' : 'https://uat.finserve.africa';
    // 1) Merchant auth -> bearer token.
    const authRes = await fetch(`${base}/authentication/api/v3/authenticate/merchant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': creds.api_key },
      body: JSON.stringify({ merchantCode: creds.merchant_code, consumerSecret: creds.consumer_secret }),
    });
    const auth = await authRes.json().catch(() => ({}));
    const token = (auth as any).accessToken ?? (auth as any).access_token;
    if (!token) throw new Error(`Jenga auth failed (${authRes.status})`);
    // 2) Initiate M-Pesa STK to credit the ISP's Equity account (accountNo).
    const body = {
      merchant: { accountNumber: req.accountNo, countryCode: 'KE', name: req.reference },
      payment: { ref: req.reference, amount: String(req.amountKes), currency: 'KES', telco: 'Safaricom', mobileNumber: req.phone, date: '', callbackUrl: req.callbackUrl },
    };
    const res = await fetch(`${base}/v3-apis/payment-api/v3.0/stkpush/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    console.log('[bankstk:equity_jenga] response:', res.status, JSON.stringify(raw));
    const ref = (raw as any).transactionId ?? (raw as any).reference ?? (raw as any).transactionRef;
    return { ok: res.ok && !!ref, providerRef: ref, message: res.ok ? `STK prompt sent to ${req.phone}` : `Jenga STK error (${res.status})`, simulated: false, raw };
  },
};

const kcb: Adapter = {
  async initiate(creds, req) {
    const base = req.env === 'live' ? 'https://api.buni.kcbgroup.com' : 'https://uat.buni.kcbgroup.com';
    // 1) OAuth client-credentials token.
    const tokRes = await fetch(`${base}/token?grant_type=client_credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${creds.consumer_key}:${creds.consumer_secret}`).toString('base64')}` },
    });
    const tok = await tokRes.json().catch(() => ({}));
    const token = (tok as any).access_token ?? creds.api_key;
    if (!token) throw new Error(`KCB auth failed (${tokRes.status})`);
    // 2) STK push crediting the ISP's KCB account (accountNo) via paybill.
    const body = {
      phoneNumber: req.phone, amount: String(req.amountKes),
      invoiceNumber: req.reference, accountReference: req.accountNo,
      orgShortCode: req.paybill, callbackUrl: req.callbackUrl, transactionDescription: 'Hotspot',
    };
    const res = await fetch(`${base}/mm/api/request/1.0.0/stkpush`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(() => ({}));
    console.log('[bankstk:kcb] response:', res.status, JSON.stringify(raw));
    const ref = (raw as any).transactionId ?? (raw as any).CheckoutRequestID ?? (raw as any).reference;
    return { ok: res.ok && !!ref, providerRef: ref, message: res.ok ? `STK prompt sent to ${req.phone}` : `KCB STK error (${res.status})`, simulated: false, raw };
  },
};

const ADAPTERS: Record<BankProvider, Adapter> = { equity_jenga: equityJenga, kcb };

/**
 * Fire the bank STK prompt. Falls back to SIMULATE when the provider has no
 * credentials yet (or BANK_STK_SIMULATION=true) so the end-to-end flow is
 * demoable before bank onboarding completes.
 */
export async function initiateBankStk(provider: BankProvider, req: BankStkRequest): Promise<BankStkResult> {
  const creds = await readCreds(provider);
  const simulate = process.env.BANK_STK_SIMULATION === 'true' || !configured(provider, creds);
  if (simulate) {
    return {
      ok: true,
      providerRef: `BSTKSIM-${req.reference}`,
      message: `[Simulated] STK prompt to ${req.phone} for KES ${req.amountKes} → ${provider} account ${req.accountNo}`,
      simulated: true,
    };
  }
  try {
    return await ADAPTERS[provider].initiate(creds, req);
  } catch (e) {
    console.error(`[bankstk:${provider}] error:`, (e as Error).message);
    return { ok: false, message: `Bank STK failed: ${(e as Error).message}`, simulated: false };
  }
}
