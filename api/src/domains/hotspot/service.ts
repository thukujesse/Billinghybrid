import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { config } from '../../config.js';
import { stkPush, normalizeMsisdn, parseCallback } from '../payments/daraja.js';
import { isMpesaSimulated } from '../settings/service.js';
import { emit as emitPortalEvent } from '../portal/events.js';

export interface HotspotGrant {
  /** Username to pass to MikroTik hotspot login (typically = voucher code). */
  username: string;
  /** Password to pass to MikroTik hotspot login (we accept any non-empty). */
  password: string;
  /** Session-Timeout reply attribute, in seconds. */
  validitySeconds: number;
  /** Rate limit string (e.g. "5M/5M") for the customer's link. */
  rateLimit: string | null;
  /** Plan name for friendly UI display. */
  planName: string;
}

/**
 * Voucher-based hotspot grant. Atomically:
 *   1. Mark the voucher used
 *   2. Insert radcheck row keyed by the voucher code (= the username
 *      MikroTik will send in its hotspot Access-Request)
 *   3. Insert radreply rows for Session-Timeout + Mikrotik-Rate-Limit
 * Returns the credentials the portal page will pass back to MikroTik.
 */
export async function redeemVoucher(input: {
  code: string;
  mac?: string;
}): Promise<HotspotGrant> {
  const code = input.code.trim().toUpperCase();
  if (!code) throw badRequest('voucher code required');

  // MAC-lock: require the captive portal to pass the MikroTik-observed MAC
  // so we can bind the voucher to one device. Without this, a code shared
  // over WhatsApp lets multiple devices ride the same plan.
  const { normalizeMac } = await import('../hotspotDevices/service.js');
  const mac = normalizeMac(input.mac);
  if (!mac) {
    void emitPortalEvent({
      type: 'voucher_redeem', mac: input.mac ?? null, success: false,
      reason: 'no_mac', detail: { code_prefix: code.slice(0, 4) },
    });
    throw badRequest('device MAC required (captive portal must include ?mac=...)');
  }

  return withTransaction(async (c) => {
    // Lock voucher row + load plan in one go.
    const r = await c.query<{
      voucher_id: string;
      status: string;
      voucher_expires: string | null;
      plan_id: string;
      plan_name: string;
      validity_days: number;
      speed_down_kbps: number | null;
      speed_up_kbps: number | null;
    }>(
      `SELECT v.id AS voucher_id, v.status, v.expires_at AS voucher_expires,
              p.id AS plan_id, p.name AS plan_name, p.validity_days,
              p.speed_down_kbps, p.speed_up_kbps
         FROM vouchers v
         JOIN plans p ON p.id = v.plan_id
        WHERE v.code = $1 FOR UPDATE OF v`,
      [code]
    );
    const voucher = r.rows[0];
    if (!voucher) {
      void emitPortalEvent({
        type: 'voucher_redeem', mac, success: false, reason: 'not_found',
        detail: { code_prefix: code.slice(0, 4) },
      });
      throw notFound('voucher');
    }
    if (voucher.status !== 'unused') {
      void emitPortalEvent({
        type: 'voucher_redeem', mac, success: false, reason: voucher.status,
        detail: { code_prefix: code.slice(0, 4), voucher_id: voucher.voucher_id, plan: voucher.plan_name },
      });
      throw conflict(`voucher is ${voucher.status}`);
    }
    if (voucher.voucher_expires && new Date(voucher.voucher_expires) < new Date()) {
      await c.query(`UPDATE vouchers SET status='expired' WHERE id=$1`, [voucher.voucher_id]);
      void emitPortalEvent({
        type: 'voucher_redeem', mac, success: false, reason: 'expired',
        detail: { code_prefix: code.slice(0, 4), voucher_id: voucher.voucher_id, plan: voucher.plan_name },
      });
      throw conflict('voucher has expired');
    }

    // Compute reply attributes from the plan.
    const validitySeconds = Math.max(60, voucher.validity_days * 86400);
    const rateLimit = voucher.speed_down_kbps && voucher.speed_up_kbps
      ? `${voucher.speed_up_kbps}k/${voucher.speed_down_kbps}k`
      : null;

    // Lock the voucher to this device. status='used' alone would already
    // prevent re-redemption, but storing the MAC is useful for audit /
    // support ("Yes, your voucher was used by aa:bb:..., not some other phone").
    await c.query(
      `UPDATE vouchers SET status='used', used_at=now(), mac_address=$2 WHERE id=$1`,
      [voucher.voucher_id, mac]
    );

    // Drive subsequent reconnects through the same MAC-auth path used by
    // M-Pesa purchases — no radcheck row keyed by the voucher code, so the
    // code itself can't be replayed from a different device. active_devices
    // is the source of truth; the FreeRADIUS authorize_check_query override
    // joins it for MAC-as-username Access-Requests.
    await c.query(
      `INSERT INTO active_devices (
         mac, expires_at, rate_limit, session_timeout_seconds, idle_timeout_seconds,
         source, phone
       ) VALUES ($1, now() + ($2 || ' seconds')::interval, $3, $4, 600, 'voucher', NULL)
       ON CONFLICT (mac) DO UPDATE SET
         expires_at = GREATEST(active_devices.expires_at, EXCLUDED.expires_at),
         rate_limit = EXCLUDED.rate_limit,
         session_timeout_seconds = EXCLUDED.session_timeout_seconds,
         source = 'voucher',
         last_seen = now()`,
      [mac, String(validitySeconds), rateLimit, validitySeconds]
    );

    void emitPortalEvent({
      type: 'voucher_redeem', mac, success: true,
      detail: {
        code_prefix: code.slice(0, 4),
        voucher_id: voucher.voucher_id,
        plan: voucher.plan_name,
        validity_seconds: validitySeconds,
      },
    });
    void emitPortalEvent({
      type: 'grant_issued', mac, success: true,
      detail: { source: 'voucher', plan: voucher.plan_name, validity_seconds: validitySeconds },
    });
    return {
      username: mac,
      password: mac,
      validitySeconds,
      rateLimit,
      planName: voucher.plan_name,
    };
  });
}

export interface HotspotBranding {
  name: string;
  color: string;
  tagline: string;
  logoUrl: string | null;
}

const HARDCODED_FALLBACK: HotspotBranding = {
  name: 'HUB Networks',
  color: '#2563eb',
  tagline: 'Connect to Wi-Fi',
  logoUrl: null,
};

async function getGlobalBranding(): Promise<HotspotBranding> {
  const r = await query<{ name: string; color: string; tagline: string; logo_url: string | null }>(
    `SELECT name, color, tagline, logo_url FROM hotspot_branding WHERE id = TRUE LIMIT 1`
  );
  const row = r.rows[0];
  if (!row) return HARDCODED_FALLBACK;
  return {
    name: row.name,
    color: row.color,
    tagline: row.tagline,
    logoUrl: row.logo_url,
  };
}

/**
 * Resolve the branding for a captive-portal request. Slug is either the
 * router's `brand_slug` (admin-set) or its UUID — both work as lookup keys.
 * Per-router branding fills missing fields from the global singleton; the
 * singleton in turn falls back to a hard-coded default if absent.
 */
export async function getBranding(slug: string): Promise<HotspotBranding> {
  const fallback = await getGlobalBranding();
  const s = slug.trim();
  if (!s) return fallback;
  const r = await query<{
    brand_name: string | null;
    brand_color: string | null;
    brand_tagline: string | null;
    brand_logo_url: string | null;
  }>(
    `SELECT brand_name, brand_color, brand_tagline, brand_logo_url
       FROM routers
      WHERE brand_slug = $1 OR id::text = $1
      LIMIT 1`,
    [s]
  );
  const row = r.rows[0];
  if (!row) return fallback;
  return {
    name: row.brand_name ?? fallback.name,
    color: row.brand_color ?? fallback.color,
    tagline: row.brand_tagline ?? fallback.tagline,
    logoUrl: row.brand_logo_url ?? fallback.logoUrl,
  };
}

/** Admin: read the global branding singleton. */
export async function getGlobalBrandingAdmin(): Promise<HotspotBranding> {
  return getGlobalBranding();
}

/**
 * Admin: update the global branding. Logo is a data: URL (base64 PNG/JPG).
 * Reject anything bigger than 200 KB pre-encode so the table doesn't bloat.
 */
export async function setGlobalBranding(input: {
  name?: string;
  color?: string;
  tagline?: string;
  logoUrl?: string | null;
}): Promise<HotspotBranding> {
  const sets: string[] = [];
  const vals: any[] = [];
  if (input.name !== undefined) {
    if (!input.name.trim()) throw badRequest('name cannot be empty');
    vals.push(input.name.trim()); sets.push(`name = $${vals.length}`);
  }
  if (input.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw badRequest('color must be a hex like #2563eb');
    vals.push(input.color); sets.push(`color = $${vals.length}`);
  }
  if (input.tagline !== undefined) {
    vals.push(input.tagline.trim()); sets.push(`tagline = $${vals.length}`);
  }
  if (input.logoUrl !== undefined) {
    if (input.logoUrl !== null) {
      if (!/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(input.logoUrl)) {
        throw badRequest('logoUrl must be a data:image/... base64 URL');
      }
      if (input.logoUrl.length > 280_000) {  // ~200 KB pre-encode
        throw badRequest('logo too large — keep it under 200 KB before encoding');
      }
    }
    vals.push(input.logoUrl); sets.push(`logo_url = $${vals.length}`);
  }
  if (sets.length === 0) return getGlobalBranding();
  sets.push(`updated_at = now()`);
  await query(`UPDATE hotspot_branding SET ${sets.join(', ')} WHERE id = TRUE`, vals);

  // Branding drives what the captive templates render — push the refreshed
  // templates to every reachable router in the background. Fire-and-forget:
  // the admin's PUT returns immediately, and per-router results show up in
  // the routers page sync-status badges within ~5-10s. A failed sync on
  // some routers doesn't roll back the branding change.
  void (async () => {
    try {
      const routerSvc = await import('../routers/service.js');
      const { results, total } = await routerSvc.syncAllRouterTemplates();
      const okCount = results.filter((r) => r.ok).length;
      console.log(`[branding] templates fanned out to ${okCount}/${total} routers`);
    } catch (err) {
      console.error('[branding] template fan-out failed:', (err as Error).message);
    }
  })();

  return getGlobalBranding();
}

export interface PurchaseInitResult {
  checkoutRequestId: string;
  amountKes: number;
  customerMessage: string;
  simulated: boolean;
}

/**
 * Start an M-Pesa STK push for a hotspot plan. Records a pending purchase
 * row keyed by the checkoutRequestId; the Daraja callback completes it.
 * If credentials aren't configured we run "simulation mode" — return a
 * fake checkoutRequestId the portal can confirm to instantly grant access.
 */
export async function initPurchase(input: {
  planId: string;
  phone: string;
  mac?: string;
  userAgent?: string;
}): Promise<PurchaseInitResult> {
  const pr = await query<{
    id: string; name: string; price_cents: number; validity_days: number;
    speed_down_kbps: number | null; speed_up_kbps: number | null;
  }>(
    `SELECT id, name, price_cents, validity_days, speed_down_kbps, speed_up_kbps
       FROM plans WHERE id = $1 AND active = TRUE`,
    [input.planId]
  );
  const plan = pr.rows[0];
  if (!plan) throw notFound('plan');
  if (plan.price_cents <= 0) throw badRequest('plan is free — use voucher flow');

  const phone = normalizeMsisdn(input.phone);
  if (!/^254\d{9}$/.test(phone)) throw badRequest('invalid phone');

  const amountKes = Math.round(plan.price_cents / 100);
  const simulated = await isMpesaSimulated();
  let checkoutRequestId: string;
  let customerMessage: string;

  if (simulated) {
    // No M-Pesa creds — generate a fake checkoutRequestId. Portal can call
    // /confirm-test to mark this purchase successful for end-to-end testing.
    checkoutRequestId = 'SIM-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    customerMessage = `[Simulation] Would have charged ${phone} KES ${amountKes}`;
  } else {
    const res = await stkPush({
      phone,
      amountKes,
      accountReference: phone.slice(-9),
      description: plan.name.slice(0, 13),
      callbackUrl: `${config.publicApiUrl}/api/hotspot/mpesa/callback`,
    });
    checkoutRequestId = res.checkoutRequestId;
    customerMessage = res.customerMessage;
  }

  await query(
    `INSERT INTO hotspot_purchases
       (checkout_request_id, plan_id, phone, mac_address, amount_kes, status, user_agent)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
    [checkoutRequestId, plan.id, phone, input.mac ?? null, amountKes, input.userAgent ?? null]
  );

  void emitPortalEvent({
    type: 'stk_init', mac: input.mac ?? null, phone, success: true,
    userAgent: input.userAgent ?? null,
    detail: {
      checkout_request_id: checkoutRequestId,
      plan_id: plan.id,
      plan_name: plan.name,
      amount_kes: amountKes,
      simulated,
    },
  });

  return { checkoutRequestId, amountKes, customerMessage, simulated };
}

export interface PurchaseStatus {
  status: 'pending' | 'success' | 'failed' | 'expired';
  grant?: HotspotGrant;
  failureReason?: string;
  // Inline-minted device token for silent re-auth on future visits. Issued
  // ONLY when status flips to 'success' — proves possession of the
  // checkoutRequestId, which is server-generated and returned only to the
  // initiator. Replaces the deprecated /hotspot/issue-token endpoint which
  // accepted MAC as input (spoofable).
  token?: string;
  tokenExpiresAt?: string;
}

/** Portal polls this every couple of seconds while STK is in flight.
 *  `fingerprintHash` is supplied by the captive portal so that the token
 *  minted on first-success can be looked up later by browser fingerprint
 *  (fingerprint-reconnect path). The portal recomputes the fingerprint
 *  every load — there's no point caching it client-side. */
export async function getPurchaseStatus(checkoutRequestId: string, opts: { fingerprintHash?: string } = {}): Promise<PurchaseStatus> {
  const r = await query<{
    status: 'pending' | 'success' | 'failed' | 'expired';
    username: string | null;
    validity_seconds: number | null;
    rate_limit: string | null;
    plan_name: string;
    failure_reason: string | null;
    phone: string;
    mac_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT hp.status, hp.username, hp.validity_seconds, hp.rate_limit,
            p.name AS plan_name, hp.failure_reason,
            hp.phone, hp.mac_address, hp.user_agent
       FROM hotspot_purchases hp
       JOIN plans p ON p.id = hp.plan_id
      WHERE hp.checkout_request_id = $1`,
    [checkoutRequestId]
  );
  if (r.rows.length === 0) throw notFound('purchase');
  const row = r.rows[0];

  if (row.status === 'success' && row.username) {
    // Inline mint: this poll call is authorised by knowledge of the
    // server-generated checkoutRequestId. The portal stops polling after
    // first 'success' (see hotspot/page.tsx pollPurchase) so we mint once
    // per purchase in practice. Idempotent at the DB level — multiple
    // tokens are fine; only the latest stays in the customer's localStorage.
    let token: string | undefined;
    let tokenExpiresAt: string | undefined;
    try {
      const { issueToken } = await import('../hotspotDevices/tokens.js');
      const t = await issueToken({
        phone: row.phone,
        mac: row.mac_address,
        userAgent: row.user_agent,
        fingerprintHash: opts.fingerprintHash ?? null,
      });
      token = t.token;
      tokenExpiresAt = t.expiresAt;
    } catch (e) {
      // Token mint should never break the login response. Log and move on.
      console.error('[hotspot] inline token mint failed:', (e as Error).message);
    }
    return {
      status: 'success',
      grant: {
        username: row.username,
        password: row.username,
        validitySeconds: row.validity_seconds ?? 3600,
        rateLimit: row.rate_limit,
        planName: row.plan_name,
      },
      token,
      tokenExpiresAt,
    };
  }
  return { status: row.status, failureReason: row.failure_reason ?? undefined };
}

/**
 * Handle a Daraja callback (or our simulation confirmation). On success,
 * finalize the purchase: generate a unique session username, insert
 * radcheck + radreply, mark the purchase successful.
 */
export async function completePurchase(input: {
  checkoutRequestId: string;
  success: boolean;
  receipt?: string;
  failureReason?: string;
}): Promise<void> {
  // Pull out of the transaction so we can call setServiceStatus (which has its
  // own transactions) for renew-flow purchases.
  const r = await query<{
    id: string; plan_id: string; phone: string; amount_kes: number;
    validity_days: number;
    speed_down_kbps: number | null; speed_up_kbps: number | null;
    status: string;
    service_id: string | null;
    wallet_topup_customer_id: string | null;
  }>(
    `SELECT hp.id, hp.plan_id, hp.phone, hp.amount_kes, hp.status,
            hp.service_id, hp.wallet_topup_customer_id,
            p.validity_days, p.speed_down_kbps, p.speed_up_kbps
       FROM hotspot_purchases hp
       JOIN plans p ON p.id = hp.plan_id
      WHERE hp.checkout_request_id = $1`,
    [input.checkoutRequestId]
  );
  const row = r.rows[0];
  if (!row) return; // unknown checkoutRequestId, ignore (might be non-hotspot)
  if (row.status !== 'pending') return; // idempotent — already settled

  if (!input.success) {
    await query(
      `UPDATE hotspot_purchases SET status='failed', failure_reason=$2, completed_at=now()
        WHERE id=$1`,
      [row.id, input.failureReason ?? 'STK push rejected']
    );
    void emitPortalEvent({
      type: 'stk_callback', mac: null, phone: row.phone, success: false,
      reason: input.failureReason ?? 'rejected',
      detail: { checkout_request_id: input.checkoutRequestId, purchase_id: row.id },
    });
    return;
  }

  // Wallet top-up flow: credit the customer's balance instead of
  // activating a service. wallet_topup_customer_id is set by
  // wallet.initWalletTopup() on the originating STK push.
  if (row.wallet_topup_customer_id) {
    await query(
      `UPDATE hotspot_purchases SET status='success', receipt=$2, completed_at=now()
        WHERE id=$1`,
      [row.id, input.receipt ?? null]
    );
    void emitPortalEvent({
      type: 'stk_callback', phone: row.phone, success: true,
      detail: {
        checkout_request_id: input.checkoutRequestId,
        purchase_id: row.id,
        flow: 'wallet_topup',
        amount_kes: row.amount_kes,
        receipt: input.receipt ?? null,
        customer_id: row.wallet_topup_customer_id,
      },
    });
    const { creditWalletFromPurchase } = await import('../customers/wallet.js');
    try {
      await creditWalletFromPurchase({
        customerId: row.wallet_topup_customer_id,
        amountKes: row.amount_kes,
        purchaseId: row.id,
        receipt: input.receipt ?? null,
      });
    } catch (err) {
      // Money landed in M-Pesa but ledger write failed — log loudly.
      // The purchase row is the source of truth; an admin can re-trigger
      // the credit by clearing customer_wallet_txns.purchase_id and
      // re-running creditWalletFromPurchase.
      console.error('[wallet] credit from purchase failed:', (err as Error).message);
    }
    return;
  }

  // Renew flow: payment restores an existing service. Mark purchase paid,
  // then setServiceStatus -> active (which syncs radcheck + clears jtm-expired
  // address-list across all managed MikroTiks).
  if (row.service_id) {
    await query(
      `UPDATE hotspot_purchases
          SET status='success', receipt=$2, completed_at=now()
        WHERE id=$1`,
      [row.id, input.receipt ?? null]
    );
    void emitPortalEvent({
      type: 'stk_callback', phone: row.phone, success: true,
      detail: {
        checkout_request_id: input.checkoutRequestId,
        purchase_id: row.id,
        flow: 'renew',
        service_id: row.service_id,
        amount_kes: row.amount_kes,
        receipt: input.receipt ?? null,
      },
    });
    // Dynamic import to avoid circular dependency (customers/service.ts also
    // pushes radius things via this same callback path).
    const { setServiceStatus } = await import('../customers/service.js');
    try {
      await setServiceStatus(row.service_id, 'active');
    } catch (err) {
      console.error('[renew] setServiceStatus failed:', (err as Error).message);
    }
    return;
  }

  // Guest hotspot flow (original): finalize by minting fresh credentials.
  await withTransaction(async (c) => {

    // Success: generate session credentials + radcheck/radreply.
    const username = 'hs-' + crypto.randomBytes(4).toString('hex');
    const validitySeconds = Math.max(60, row.validity_days * 86400);
    const rateLimit = row.speed_down_kbps && row.speed_up_kbps
      ? `${row.speed_up_kbps}k/${row.speed_down_kbps}k`
      : null;

    await c.query(
      `INSERT INTO radcheck (username, attribute, op, value)
       VALUES ($1, 'Cleartext-Password', ':=', $1)`,
      [username]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Session-Timeout', ':=', $2)`,
      [username, String(validitySeconds)]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Idle-Timeout', ':=', '600')`,
      [username]
    );
    if (rateLimit) {
      await c.query(
        `INSERT INTO radreply (username, attribute, op, value)
         VALUES ($1, 'Mikrotik-Rate-Limit', '=', $2)`,
        [username, rateLimit]
      );
    }
    await c.query(
      `UPDATE hotspot_purchases
          SET status='success', username=$2, validity_seconds=$3,
              rate_limit=$4, receipt=$5, completed_at=now()
        WHERE id=$1`,
      [row.id, username, validitySeconds, rateLimit, input.receipt ?? null]
    );
  });
  void emitPortalEvent({
    type: 'stk_callback', phone: row.phone, success: true,
    detail: {
      checkout_request_id: input.checkoutRequestId,
      purchase_id: row.id,
      flow: 'guest_hotspot',
      amount_kes: row.amount_kes,
      receipt: input.receipt ?? null,
    },
  });
  void emitPortalEvent({
    type: 'grant_issued', phone: row.phone, success: true,
    detail: { source: 'mpesa_hotspot', purchase_id: row.id, validity_days: row.validity_days },
  });
}

/** Dispatch a Daraja callback (called by the public callback endpoint). */
export async function handleDarajaCallback(body: unknown): Promise<boolean> {
  const parsed = parseCallback(body);
  if (!parsed) return false;
  await completePurchase({
    checkoutRequestId: parsed.checkoutRequestId,
    success: parsed.success,
    receipt: parsed.receipt,
    failureReason: parsed.success ? undefined : 'M-Pesa declined or cancelled',
  });
  return true;
}

