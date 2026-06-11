/**
 * Customer-facing transactional SMS layer.
 *
 * Each helper is shaped as `sendXxx({customerId, ...})` and:
 *   1. Resolves the customer + their phone (skips silently if no phone)
 *   2. Builds a dedup_key from the event identity (so re-fires from
 *      periodic sweeps don't spam)
 *   3. Constructs an SMS body using the brand name from config
 *   4. INSERTs into customer_notifications_log with ON CONFLICT DO NOTHING
 *      — the conflict is the signal that we already sent this one
 *   5. Calls notify('sms', ...) only when the insert wrote a fresh row
 *
 * SMS failure is logged but doesn't throw — the caller (service layer
 * mutation) shouldn't fail because Africa's Talking is having a moment.
 */
import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { notify } from '../notifications/service.js';
import { render as renderTpl } from '../messageTemplates/service.js';

const BRAND = () => config.brandName;
const PORTAL_URL = () => `https://${config.portal.host}/portal`;
const RENEW_URL  = (username: string) =>
  `https://${config.portal.host}/renew?username=${encodeURIComponent(username)}`;

type Channel = 'sms' | 'email' | 'whatsapp';

interface CustomerRow {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  notification_channels: Channel[];
}

async function getCustomerForSms(customerId: string): Promise<CustomerRow | null> {
  const r = await query<CustomerRow>(
    `SELECT id, full_name, phone, email, notification_channels
       FROM customers WHERE id = $1`,
    [customerId]
  );
  if (!r.rows[0]) return null;
  return {
    ...r.rows[0],
    notification_channels: (r.rows[0].notification_channels ?? ['sms']) as Channel[],
  };
}

/** Resolve a recipient address for the channel. Returns null if the
 *  customer hasn't supplied the address for that channel (e.g. asked
 *  for email notifications but no email on file). */
function addressFor(channel: Channel, c: CustomerRow): string | null {
  if (channel === 'email') return c.email;
  // SMS + WhatsApp both ride on the phone field. Phone is normalized
  // E.164 by the customer-create path; both providers accept that.
  return c.phone;
}

/**
 * Reserve a notification slot — returns true if we're the ones that
 * should send (and the log row is now persisted), false if a previous
 * call already claimed this (customer_id, kind, dedup_key).
 *
 * Important: we INSERT before sending. If the SMS fails after, we'll
 * still have the log row marking the attempt; we update its status to
 * 'failed' so the operator can see misdeliveries.
 */
async function reserveSlot(input: {
  customerId: string; kind: string; dedupKey: string;
  toAddress: string; body: string;
}): Promise<{ id: string; alreadySent: boolean }> {
  const r = await query<{ id: string }>(
    `INSERT INTO customer_notifications_log
       (customer_id, kind, dedup_key, to_address, body, status)
     VALUES ($1, $2, $3, $4, $5, 'sent')
     ON CONFLICT (customer_id, kind, dedup_key) DO NOTHING
     RETURNING id`,
    [input.customerId, input.kind, input.dedupKey, input.toAddress, input.body]
  );
  if (!r.rows[0]) return { id: '', alreadySent: true };
  return { id: r.rows[0].id, alreadySent: false };
}

async function markFailed(id: string, err: unknown): Promise<void> {
  if (!id) return;
  await query(
    `UPDATE customer_notifications_log
        SET status = 'failed', error = $2
      WHERE id = $1`,
    [id, (err as Error).message ?? String(err)]
  ).catch(() => {/* best-effort */});
}

/**
 * Fan out a single notification across every channel the customer is
 * opted into. Dedup is per (customer, kind, dedupKey, channel) so a
 * customer on both SMS + email gets one of each, not two of one and
 * none of the other.
 *
 * For email, the body is prefixed with a Subject line so the
 * notifications service can split it ("Subject\nBody" convention).
 */
async function fireNotification(input: {
  customerId: string;
  customer: CustomerRow;
  kind: string;
  dedupKey: string;
  body: string;
  subject?: string;
}): Promise<{ sent: number; skipped: number }> {
  let sent = 0, skipped = 0;
  const channels = input.customer.notification_channels.length > 0
    ? input.customer.notification_channels
    : (['sms'] as Channel[]); // safety net — never silent-drop

  for (const channel of channels) {
    const addr = addressFor(channel, input.customer);
    if (!addr) { skipped++; continue; }
    // Email channel adopts a Subject\nBody envelope so the email module's
    // splitSubject() helper picks a meaningful subject line.
    const body = channel === 'email' && input.subject
      ? `${input.subject}\n${input.body}`
      : input.body;
    // Per-channel dedup key so opting into multiple channels doesn't
    // share a single slot (and accidentally suppress one).
    const slot = await reserveSlot({
      customerId: input.customerId,
      kind: input.kind,
      dedupKey: `${input.dedupKey}:${channel}`,
      toAddress: addr,
      body,
    });
    if (slot.alreadySent) { skipped++; continue; }
    // Record channel on the log row so the operator can see which channel
    // each delivery used. (The status column tracks success/failure.)
    await query(
      `UPDATE customer_notifications_log SET channel = $2 WHERE id = $1`,
      [slot.id, channel]
    ).catch(() => {/* best-effort */});
    try {
      await notify(channel, addr, body);
      sent++;
    } catch (err) {
      await markFailed(slot.id, err);
      console.error(`[notify-${channel}:${input.kind}]`, (err as Error).message);
    }
  }
  return { sent, skipped };
}

// Back-compat shim: keep the old fireSms signature so we don't have to
// touch every helper. New code should call fireNotification directly.
async function fireSms(input: {
  customerId: string; kind: string; dedupKey: string;
  phone: string; body: string; subject?: string;
}): Promise<{ sent: boolean; deduped: boolean }> {
  const customer = await getCustomerForSms(input.customerId);
  if (!customer) return { sent: false, deduped: false };
  const r = await fireNotification({
    customerId: input.customerId,
    customer,
    kind: input.kind,
    dedupKey: input.dedupKey,
    body: input.body,
    subject: input.subject,
  });
  return { sent: r.sent > 0, deduped: r.sent === 0 && r.skipped > 0 };
}

// =====================================================================
// Specific notification helpers
// =====================================================================

/** Onboarding — sent once when a customer's first PPPoE service is created.
 *  Includes the PPPoE creds + portal link. dedup keyed on the service so
 *  re-creating a service for the same customer would re-send (operator
 *  probably intends that). */
export async function sendOnboarding(customerId: string, service: {
  id: string; username: string | null; password: string | null;
}): Promise<void> {
  if (!service.username || !service.password) return;
  const cust = await getCustomerForSms(customerId);
  if (!cust?.phone) return;
  const body = await renderTpl('welcome', 'pppoe', {
    brand: BRAND(), first_name: cust.full_name.split(' ')[0],
    username: service.username, password: service.password, portal_url: PORTAL_URL(),
  });
  if (!body) return;
  await fireSms({
    customerId, kind: 'onboarding',
    dedupKey: service.id, phone: cust.phone, body,
  });
}

/** Wallet top-up confirmation. dedup on the purchase id so duplicate
 *  Daraja callbacks don't double-text. */
export async function sendWalletToppedUp(input: {
  customerId: string;
  amountKes: number;
  balanceCents: number;
  purchaseId: string;
  receipt?: string | null;
}): Promise<void> {
  const cust = await getCustomerForSms(input.customerId);
  if (!cust?.phone) return;
  const balanceKes = Math.round(input.balanceCents / 100);
  const receiptStr = input.receipt ? ` Receipt: ${input.receipt}.` : '';
  const body = await renderTpl('wallet_topup', 'pppoe', {
    brand: BRAND(), amount: input.amountKes, balance: balanceKes, receipt: receiptStr,
  });
  if (!body) return;
  await fireSms({
    customerId: input.customerId, kind: 'wallet.topup',
    dedupKey: input.purchaseId, phone: cust.phone, body,
  });
}

/** Auto-renew succeeded — silent renewal via wallet debit. Only fires
 *  when the worker is the actor; manual portal-driven wallet renews
 *  don't get this SMS (the customer was already in the UI). */
export async function sendAutoRenewed(input: {
  customerId: string;
  serviceId: string;
  serviceName: string;     // plan name or username
  newExpiry: string;       // ISO
  amountKes: number;
  balanceCents: number;
}): Promise<void> {
  const cust = await getCustomerForSms(input.customerId);
  if (!cust?.phone) return;
  const exp = new Date(input.newExpiry).toLocaleDateString('en-GB');
  const balanceKes = Math.round(input.balanceCents / 100);
  // dedup on serviceId + exp date — auto-renew at most one SMS per renewal cycle.
  const dedupKey = `${input.serviceId}:${input.newExpiry.slice(0, 10)}`;
  const body = await renderTpl('renewed', 'pppoe', {
    brand: BRAND(), service: input.serviceName, amount: input.amountKes, expiry: exp, balance: balanceKes,
  });
  if (!body) return;
  await fireSms({
    customerId: input.customerId, kind: 'wallet.auto_renewed',
    dedupKey, phone: cust.phone, body,
  });
}

/** Low balance — sent when wallet can't cover the next renewal AND the
 *  service is expiring within 7 days AND auto_renew is on. dedup per
 *  service per day so the customer gets at most one a day per service. */
export async function sendLowBalance(input: {
  customerId: string;
  serviceId: string;
  serviceName: string;
  priceKes: number;
  balanceCents: number;
  daysUntilExpiry: number;
}): Promise<void> {
  const cust = await getCustomerForSms(input.customerId);
  if (!cust?.phone) return;
  const balanceKes = Math.round(input.balanceCents / 100);
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `${input.serviceId}:${today}`;
  const shortfall = input.priceKes - balanceKes;
  const body = await renderTpl('low_balance', 'pppoe', {
    brand: BRAND(), service: input.serviceName, price: input.priceKes,
    days: input.daysUntilExpiry, balance: balanceKes, shortfall, portal_url: PORTAL_URL(),
  });
  if (!body) return;
  await fireSms({
    customerId: input.customerId, kind: 'wallet.low_balance',
    dedupKey, phone: cust.phone, body,
  });
}

/** Plan changed by admin — dedup on (service, before-plan-id, after-plan-id, day). */
export async function sendPlanChanged(input: {
  customerId: string;
  serviceId: string;
  oldPlanId: string | null;
  newPlanId: string;
  newPlanName: string;
  newRateLimit: string | null;
}): Promise<void> {
  const cust = await getCustomerForSms(input.customerId);
  if (!cust?.phone) return;
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `${input.serviceId}:${input.oldPlanId ?? 'none'}->${input.newPlanId}:${today}`;
  const rate = input.newRateLimit ? ` (${input.newRateLimit})` : '';
  const body = await renderTpl('plan_changed', 'pppoe', {
    brand: BRAND(), plan: input.newPlanName, rate, portal_url: PORTAL_URL(),
  });
  if (!body) return;
  await fireSms({
    customerId: input.customerId, kind: 'service.plan_changed',
    dedupKey, phone: cust.phone, body,
  });
}

/** Service suspended or restored. dedup on (service, status, day) — a
 *  service rapidly toggled doesn't spam. */
export async function sendStatusChange(input: {
  customerId: string;
  serviceId: string;
  serviceName: string;
  newStatus: 'suspended' | 'active' | 'expired' | 'cancelled';
  username: string | null;
}): Promise<void> {
  const cust = await getCustomerForSms(input.customerId);
  if (!cust?.phone) return;
  // Only suspend / restore are interesting to customers. expired has its
  // own (better) SMS sent by expireDueServices.
  if (input.newStatus !== 'suspended' && input.newStatus !== 'active') return;
  const today = new Date().toISOString().slice(0, 10);
  const dedupKey = `${input.serviceId}:${input.newStatus}:${today}`;
  const body = input.newStatus === 'suspended'
    ? await renderTpl('suspended', 'pppoe', { brand: BRAND(), service: input.serviceName })
    : await renderTpl('restored', 'pppoe', {
        brand: BRAND(), service: input.serviceName, portal_url: PORTAL_URL(),
        username: input.username ? ` · user: ${input.username}` : '',
      });
  if (!body) return;
  await fireSms({
    customerId: input.customerId, kind: 'service.status_change',
    dedupKey, phone: cust.phone, body,
  });
}

/** Admin-triggered resend of the onboarding SMS (e.g. customer lost their
 *  creds slip). Bypasses dedup by salting the key with the current
 *  timestamp — operator intentionally wants to resend. */
export async function resendOnboarding(customerId: string, serviceId: string): Promise<void> {
  const cust = await getCustomerForSms(customerId);
  if (!cust?.phone) throw new Error('customer has no phone on file');
  const r = await query<{ username: string | null; password: string | null }>(
    `SELECT username, password FROM services WHERE id = $1 AND customer_id = $2`,
    [serviceId, customerId]
  );
  const svc = r.rows[0];
  if (!svc?.username || !svc?.password) throw new Error('service has no PPPoE credentials');
  // Operator-initiated resend always sends even if the auto-welcome is disabled.
  const body = (await renderTpl('welcome', 'pppoe', {
    brand: BRAND(), first_name: cust.full_name.split(' ')[0],
    username: svc.username, password: svc.password, portal_url: PORTAL_URL(),
  })) ?? `${BRAND()}: Your internet login — user: ${svc.username} pass: ${svc.password}. Manage your plan: ${PORTAL_URL()}`;
  // dedup key includes timestamp so this fires fresh every time.
  const dedupKey = `${serviceId}:resend:${Date.now()}`;
  await fireSms({
    customerId, kind: 'onboarding.resend',
    dedupKey, phone: cust.phone, body,
  });
}

/**
 * Low-balance sweep — used by the expire-worker. Finds active PPPoE
 * services with auto_renew=true and expiry within `windowHours`, where
 * the customer's wallet balance is below the plan price. SMSes each
 * once per day. Returns the count of customers SMSed.
 */
export async function lowBalanceSweep(windowHours = 7 * 24): Promise<{ warned: number }> {
  const r = await query<{
    customer_id: string;
    service_id: string;
    service_name: string;
    price_cents: number;
    balance_cents: number;
    days_until_expiry: number;
  }>(
    `SELECT s.customer_id,
            s.id AS service_id,
            COALESCE(p.name, s.username, 'your plan') AS service_name,
            p.price_cents,
            COALESCE(w.balance_cents, 0)::bigint AS balance_cents,
            GREATEST(0, EXTRACT(EPOCH FROM (s.expiry_date - now())) / 86400)::int AS days_until_expiry
       FROM services s
       JOIN plans p ON p.id = s.plan_id
       LEFT JOIN customer_wallets w ON w.customer_id = s.customer_id
      WHERE s.service_type = 'pppoe'
        AND s.status = 'active'
        AND s.auto_renew = TRUE
        AND s.expiry_date IS NOT NULL
        AND s.expiry_date > now()
        AND s.expiry_date < now() + ($1 || ' hours')::interval
        AND COALESCE(w.balance_cents, 0) < p.price_cents`,
    [String(windowHours)]
  );
  let warned = 0;
  for (const row of r.rows) {
    const r2 = await sendLowBalance({
      customerId: row.customer_id,
      serviceId: row.service_id,
      serviceName: row.service_name,
      priceKes: Math.round(row.price_cents / 100),
      balanceCents: Number(row.balance_cents),
      daysUntilExpiry: row.days_until_expiry,
    }).then(() => ({ ok: true })).catch(() => ({ ok: false }));
    if (r2.ok) warned++;
  }
  return { warned };
}
