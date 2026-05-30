import { config } from '../../config.js';

/**
 * M-Pesa Daraja client (STK Push). Activates only when consumer key/secret are
 * configured; otherwise the payment service stays in simulation mode and this
 * client is never called. Uses global fetch (Node 18+) — no SDK dependency.
 */

const BASE =
  config.mpesa.env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const auth = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString('base64');
  const res = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Daraja auth failed (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: string };
  // Refresh a minute before expiry.
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 60) * 1000 };
  return cachedToken.value;
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Normalize a Kenyan MSISDN to 2547######## / 2541########. */
export function normalizeMsisdn(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  return digits;
}

export interface StkPushResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  responseCode: string;
  customerMessage: string;
}

/**
 * Trigger an STK push. `amount` is in whole KES (Daraja does not accept cents).
 * The accountReference shows on the customer's prompt.
 */
export async function stkPush(input: {
  phone: string;
  amountKes: number;
  accountReference: string;
  description?: string;
}): Promise<StkPushResult> {
  const token = await getAccessToken();
  const ts = timestamp();
  const password = Buffer.from(`${config.mpesa.shortcode}${config.mpesa.passkey}${ts}`).toString('base64');

  const res = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: config.mpesa.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.max(1, Math.round(input.amountKes)),
      PartyA: normalizeMsisdn(input.phone),
      PartyB: config.mpesa.shortcode,
      PhoneNumber: normalizeMsisdn(input.phone),
      CallBackURL: config.mpesa.callbackUrl,
      AccountReference: input.accountReference.slice(0, 12),
      TransactionDesc: (input.description ?? 'Payment').slice(0, 13),
    }),
  });

  const data = (await res.json()) as any;
  if (!res.ok || data.ResponseCode !== '0') {
    throw new Error(`STK push failed: ${data.errorMessage ?? data.ResponseDescription ?? res.status}`);
  }
  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
    responseCode: data.ResponseCode,
    customerMessage: data.CustomerMessage,
  };
}

/**
 * Parse a Daraja STK callback body into a normalized outcome. The callback
 * posts { Body: { stkCallback: { CheckoutRequestID, ResultCode, ... } } }.
 */
export function parseCallback(body: any): {
  checkoutRequestId: string;
  success: boolean;
  receipt?: string;
  amount?: number;
} | null {
  const cb = body?.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return null;
  const success = cb.ResultCode === 0 || cb.ResultCode === '0';
  let receipt: string | undefined;
  let amount: number | undefined;
  const items = cb.CallbackMetadata?.Item ?? [];
  for (const it of items) {
    if (it.Name === 'MpesaReceiptNumber') receipt = String(it.Value);
    if (it.Name === 'Amount') amount = Number(it.Value);
  }
  return { checkoutRequestId: cb.CheckoutRequestID, success, receipt, amount };
}
