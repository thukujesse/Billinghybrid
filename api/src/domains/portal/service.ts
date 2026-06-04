/**
 * Customer self-serve portal — backs /portal/* routes.
 *
 * Auth path: customer enters phone → SMS OTP (handled by auth/service.ts'
 * requestCustomerOtp / verifyCustomerOtp) → JWT with role='customer' →
 * subsequent reads use the JWT's `sub` claim as the customer_id.
 *
 * Everything here trusts that the caller has already been verified via
 * requireAuth('customer'). DO NOT call from anywhere else without that
 * guard or you bypass the OTP gate.
 */
import { query } from '../../db/pool.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { getCustomer, getCustomerPayments } from '../customers/service.js';
import { pay as renewPay } from '../renew/service.js';
import { getWallet as getCustomerWallet, listTxns as listWalletTxns } from '../customers/wallet.js';

export interface PortalMe {
  customer: {
    id: string;
    account_number: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    status: 'active' | 'suspended' | 'closed';
    notification_channels: Array<'sms' | 'email' | 'whatsapp'>;
  };
  wallet: {
    balance_cents: number;
    updated_at: string;
  };
  services: Array<{
    id: string;
    service_type: string;
    username: string | null;
    plan_id: string | null;
    plan_name: string | null;
    plan_price_cents: number | null;
    rate_limit: string | null;
    status: 'active' | 'suspended' | 'expired' | 'cancelled';
    expiry_date: string | null;
    seconds_remaining: number | null;
    auto_renew: boolean;
    // Live session counters (radacct) — null when no current session.
    current_session: {
      started_at: string;
      framed_ip: string | null;
      bytes_in: number;
      bytes_out: number;
    } | null;
    // Sum since service creation across all sessions — friendly "this month" feel.
    period_bytes_total: number;
  }>;
  recent_payments: Array<{
    id: string;
    amount_kes: number;
    plan_name: string | null;
    status: string;
    created_at: string;
  }>;
}

export async function getPortalMe(customerId: string): Promise<PortalMe> {
  const c = await getCustomer(customerId);

  // Enrich every service with: plan name + price, auto-renew flag,
  // live session, period totals.
  const enriched = await Promise.all(c.services.map(async (s) => {
    let plan_name: string | null = null;
    let plan_price_cents: number | null = null;
    if (s.plan_id) {
      const pr = await query<{ name: string; price_cents: number }>(
        `SELECT name, price_cents FROM plans WHERE id = $1`, [s.plan_id]
      );
      plan_name = pr.rows[0]?.name ?? null;
      plan_price_cents = pr.rows[0]?.price_cents ?? null;
    }
    // auto_renew was added by migration 034 — read via fresh query rather
    // than threading it through getCustomer for now.
    const ar = await query<{ auto_renew: boolean }>(
      `SELECT auto_renew FROM services WHERE id = $1`, [s.id]
    );
    const auto_renew = ar.rows[0]?.auto_renew ?? true;
    const secondsRemaining = s.expiry_date
      ? Math.max(0, Math.floor((new Date(s.expiry_date).getTime() - Date.now()) / 1000))
      : null;

    let current_session: PortalMe['services'][number]['current_session'] = null;
    let period_bytes_total = 0;
    if (s.username) {
      // Live session — at most one for PPPoE.
      const live = await query<{
        acctstarttime: string; framed_ip: string | null;
        bytes_in: string; bytes_out: string;
      }>(
        `SELECT acctstarttime,
                host(framedipaddress) AS framed_ip,
                COALESCE(acctinputoctets, 0)::text AS bytes_in,
                COALESCE(acctoutputoctets, 0)::text AS bytes_out
           FROM radacct
          WHERE username = $1 AND acctstoptime IS NULL
          ORDER BY acctstarttime DESC LIMIT 1`,
        [s.username]
      );
      if (live.rows[0]) {
        current_session = {
          started_at: live.rows[0].acctstarttime,
          framed_ip: live.rows[0].framed_ip,
          bytes_in: Number(live.rows[0].bytes_in) || 0,
          bytes_out: Number(live.rows[0].bytes_out) || 0,
        };
      }
      // Total since service creation. For PPPoE this is essentially "ever";
      // for a daily/weekly plan, it's "this billing window".
      const totals = await query<{ total: string }>(
        `SELECT COALESCE(SUM(COALESCE(acctinputoctets,0) + COALESCE(acctoutputoctets,0)), 0)::text AS total
           FROM radacct
          WHERE username = $1 AND acctstarttime >= $2`,
        [s.username, s.created_at]
      );
      period_bytes_total = Number(totals.rows[0]?.total) || 0;
    }

    return {
      id: s.id,
      service_type: s.service_type,
      username: s.username,
      plan_id: s.plan_id,
      plan_name,
      plan_price_cents,
      rate_limit: s.rate_limit,
      status: s.status,
      expiry_date: s.expiry_date,
      seconds_remaining: secondsRemaining,
      auto_renew,
      current_session,
      period_bytes_total,
    };
  }));

  const [payments, wallet] = await Promise.all([
    getCustomerPayments(customerId, 10),
    getCustomerWallet(customerId),
  ]);

  return {
    customer: {
      id: c.id,
      account_number: c.account_number,
      full_name: c.full_name,
      phone: c.phone,
      email: c.email,
      status: c.status,
      // notification_channels lives on the customer row but isn't part of
      // the `Customer` interface yet — read it via a side query rather
      // than widening the type globally for this one consumer.
      notification_channels: await (async () => {
        const r = await query<{ notification_channels: Array<'sms' | 'email' | 'whatsapp'> }>(
          `SELECT notification_channels FROM customers WHERE id = $1`, [c.id]
        );
        return r.rows[0]?.notification_channels ?? ['sms'];
      })(),
    },
    wallet: {
      balance_cents: wallet.balance_cents,
      updated_at: wallet.updated_at,
    },
    services: enriched,
    recent_payments: payments.map((p) => ({
      id: p.id,
      amount_kes: p.amount_kes,
      plan_name: p.plan_name,
      status: p.status,
      created_at: p.created_at,
    })),
  };
}

// Re-export so the portal route layer doesn't need its own wallet import.
export { listWalletTxns };

/**
 * Customer-initiated renewal — wraps the existing hotspot M-Pesa STK
 * flow. We verify the service belongs to the authenticated customer
 * before triggering the push so a stolen JWT can't pay for someone
 * else's service.
 */
export async function portalRenew(input: {
  customerId: string;
  serviceId: string;
  planId: string;
  phone: string;
}): Promise<{ checkoutRequestId: string; amountKes: number; customerMessage: string; simulated: boolean }> {
  const r = await query<{ id: string; customer_id: string; username: string | null }>(
    `SELECT id, customer_id, username FROM services WHERE id = $1`,
    [input.serviceId]
  );
  const svc = r.rows[0];
  if (!svc) throw notFound('service');
  if (svc.customer_id !== input.customerId) {
    throw badRequest('service does not belong to the authenticated customer');
  }
  // Reuse renew.pay — it stamps service_id on the hotspot_purchases row
  // so the callback handler in hotspot/service.ts routes the success to
  // setServiceStatus(active) (limp-mode restore) instead of minting a
  // guest credential.
  return renewPay({
    planId: input.planId,
    phone: input.phone,
    serviceId: input.serviceId,
  });
}