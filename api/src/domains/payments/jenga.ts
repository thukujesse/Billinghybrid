/**
 * Jenga / Equity (JengaHQ / Finserve) IPN adapter.
 *
 * A bank paybill fronted by Jenga can't reach us through Safaricom Daraja — the
 * money lands in the bank and Jenga POSTs an Instant Payment Notification to our
 * registered callback URL. We normalize that payload into the SAME shape our C2B
 * settlement engine already consumes, so reference-matching, TransID dedup and
 * the underpayment guard are all reused — no second settlement path.
 *
 * Jenga field names differ slightly per account/product, so we read the common
 * variants and ALWAYS log the raw payload: the first real callback tells us the
 * exact shape, and any tweak is a one-line change here.
 */
import { handleC2bConfirmation, type C2bConfirmation } from './c2b.js';

function pick(...vals: Array<unknown>): string {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export async function handleJengaIpn(payload: any): Promise<{ matched: boolean; note: string }> {
  // Always log raw — this is how we lock the exact field mapping on the first
  // real Jenga callback. Safe: it's an inbound bank notification, not a secret.
  console.log('[jenga-ipn] raw:', JSON.stringify(payload));

  const t = payload?.transaction ?? payload?.Transaction ?? {};
  const c = payload?.customer ?? payload?.Customer ?? {};

  // The bill/account number the customer typed = OUR generated reference (HUB######).
  const reference = pick(t.billNumber, t.billNo, t.accountNumber, t.account, c.reference,
                         payload?.billNumber, payload?.accountNumber, payload?.reference);
  // Jenga's own transaction id — used for idempotent dedup.
  const txnId = pick(t.reference, t.transactionId, t.transactionRef, payload?.transactionId,
                     payload?.transactionReference, payload?.id);
  // Amount paid.
  const amount = pick(t.amount, t.orderAmount, payload?.amount);
  // Payer mobile (best-effort; we match on reference, not phone).
  const msisdn = pick(c.mobileNumber, c.mobile, c.msisdn, payload?.mobileNumber);

  const mapped: C2bConfirmation = {
    TransID: txnId,
    TransAmount: amount,
    BillRefNumber: reference,
    MSISDN: msisdn,
  };
  const result = await handleC2bConfirmation(mapped);
  console.log(`[jenga-ipn] ref=${reference} amount=${amount} txn=${txnId} -> ${result.note}`);
  return result;
}
