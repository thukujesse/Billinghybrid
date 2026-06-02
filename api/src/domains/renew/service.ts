import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { config } from '../../config.js';
import { stkPush, normalizeMsisdn } from '../payments/daraja.js';
import crypto from 'node:crypto';

export interface RenewInfo {
  customer: { full_name: string; account_number: string; phone: string | null } | null;
  service: { id: string; username: string | null; service_type: string } | null;
  plans: { id: string; name: string; price_cents: number; validity_days: number }[];
  reason: string;
}

/**
 * Identify the customer behind a captive-portal renewal request. We try
 * several keys in order: explicit customer/service from the URL, then the
 * username (matches services.username), then the IP (matches radacct's most
 * recent open session for any of our managed routers).
 */
interface SvcRow {
  service_id: string;
  service_type: string;
  username: string | null;
  customer_id: string;
  full_name: string;
  account_number: string;
  phone: string | null;
}

export async function getInfo(params: {
  customer?: string; service?: string; username?: string; ip?: string;
}): Promise<RenewInfo> {
  let svcRow: SvcRow | null = null;

  if (params.service) {
    const r = await query<SvcRow>(
      `SELECT s.id AS service_id, s.service_type, s.username,
              c.id AS customer_id, c.full_name, c.account_number, c.phone
         FROM services s JOIN customers c ON c.id = s.customer_id
        WHERE s.id = $1`,
      [params.service]
    );
    svcRow = r.rows[0] ?? null;
  }
  if (!svcRow && params.username) {
    const r = await query<SvcRow>(
      `SELECT s.id AS service_id, s.service_type, s.username,
              c.id AS customer_id, c.full_name, c.account_number, c.phone
         FROM services s JOIN customers c ON c.id = s.customer_id
        WHERE s.username = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [params.username]
    );
    svcRow = r.rows[0] ?? null;
  }
  if (!svcRow && params.customer) {
    const r = await query<SvcRow>(
      `SELECT s.id AS service_id, s.service_type, s.username,
              c.id AS customer_id, c.full_name, c.account_number, c.phone
         FROM services s JOIN customers c ON c.id = s.customer_id
        WHERE c.account_number = $1 OR c.id::text = $1
        ORDER BY s.created_at DESC LIMIT 1`,
      [params.customer]
    );
    svcRow = r.rows[0] ?? null;
  }
  if (!svcRow && params.ip) {
    // Look up via active accounting — even though it's now closed (we kicked
    // them) the username from the most recent session matches our service.
    const r = await query<SvcRow>(
      `SELECT s.id AS service_id, s.service_type, s.username,
              c.id AS customer_id, c.full_name, c.account_number, c.phone
         FROM radacct a
         JOIN services s ON s.username = a.username
         JOIN customers c ON c.id = s.customer_id
        WHERE host(a.framedipaddress) = $1
        ORDER BY a.acctstarttime DESC LIMIT 1`,
      [params.ip]
    );
    svcRow = r.rows[0] ?? null;
  }

  const planType = svcRow?.service_type === 'hotspot' ? 'hotspot' : 'prepaid';
  const plansR = await query<{
    id: string; name: string; price_cents: number; validity_days: number;
  }>(
    `SELECT id, name, price_cents, validity_days FROM plans
      WHERE active = TRUE AND price_cents > 0
        AND (type = $1 OR type = 'postpaid')
      ORDER BY price_cents ASC LIMIT 20`,
    [planType]
  );

  return {
    customer: svcRow ? {
      full_name: svcRow.full_name,
      account_number: svcRow.account_number,
      phone: svcRow.phone,
    } : null,
    service: svcRow ? {
      id: svcRow.service_id, username: svcRow.username, service_type: svcRow.service_type,
    } : null,
    plans: plansR.rows,
    reason: svcRow ? '' : 'No active service matched the lookup keys.',
  };
}

export interface RenewPayResult {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
}

/**
 * Trigger an STK push for a service renewal. The hotspot_purchases row gets
 * service_id set so the callback handler in hotspot/service.ts knows to
 * restore the service (status=active) instead of minting a guest credential.
 */
export async function pay(input: {
  planId: string; phone: string; serviceId: string;
}): Promise<RenewPayResult> {
  const pr = await query<{ id: string; name: string; price_cents: number }>(
    `SELECT id, name, price_cents FROM plans WHERE id = $1 AND active = TRUE`,
    [input.planId]
  );
  const plan = pr.rows[0];
  if (!plan) throw notFound('plan');
  if (plan.price_cents <= 0) throw badRequest('plan is free');

  const sr = await query<{ id: string }>(`SELECT id FROM services WHERE id = $1`, [input.serviceId]);
  if (!sr.rows[0]) throw notFound('service');

  const phone = normalizeMsisdn(input.phone);
  if (!/^254\d{9}$/.test(phone)) throw badRequest('invalid phone');

  const amountKes = Math.round(plan.price_cents / 100);
  const simulated = config.mpesa.simulated;
  let checkoutRequestId: string;
  let customerMessage: string;

  if (simulated) {
    checkoutRequestId = 'SIM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    customerMessage = `[Simulation] Would have charged ${phone} KES ${amountKes}`;
  } else {
    const res = await stkPush({
      phone, amountKes,
      accountReference: phone.slice(-9),
      description: `Renew ${plan.name}`.slice(0, 13),
    });
    checkoutRequestId = res.checkoutRequestId;
    customerMessage = res.customerMessage;
  }

  await query(
    `INSERT INTO hotspot_purchases
       (checkout_request_id, plan_id, phone, amount_kes, status, service_id)
     VALUES ($1, $2, $3, $4, 'pending', $5)`,
    [checkoutRequestId, plan.id, phone, amountKes, input.serviceId]
  );

  return { checkoutRequestId, amountKes, customerMessage, simulated };
}
