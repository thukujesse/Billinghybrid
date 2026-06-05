/**
 * Hotspot device registry: returning-customer auto-auth + SMS-OTP MAC rebind.
 *
 * Flow:
 *   Customer connects -> captive opens portal -> portal calls lookup(mac).
 *   If active grant exists, portal auto-submits MikroTik login form with
 *   the stored radcheck credentials — no payment UI shown.
 *
 *   If the device randomized its MAC (iOS Private Wi-Fi Address default),
 *   the lookup misses. Customer taps "I changed phone / device", enters
 *   their phone, gets SMS OTP, and on verify we copy the prior grant
 *   onto the new MAC and they're online without re-paying.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { normalizeMsisdn } from '../payments/daraja.js';
import { notify } from '../notifications/service.js';

export interface ActiveDevice {
  mac: string;
  expires_at: string;
  rate_limit: string | null;
  session_timeout_seconds: number;
  idle_timeout_seconds: number;
  source: 'hotspot_purchase' | 'voucher' | 'admin' | 'rebind';
  phone: string | null;
  purchase_id: string | null;
  customer_id: string | null;
  rebound_from_mac: string | null;
  first_seen: string;
  last_seen: string;
}

export interface LookupResult {
  active: boolean;
  // When active=true: the credentials the portal will submit to MikroTik.
  // We don't store a separate radcheck row per device; we fabricate
  // mac-based creds (username=mac, password=mac) and rely on the
  // FreeRADIUS queries.conf override (sprint-2 install.sh) to accept
  // them by matching active_devices.
  username?: string;
  password?: string;
  validitySeconds?: number;
  secondsRemaining?: number;
  rateLimit?: string | null;
  phone?: string | null;
  // Inline-minted device token (Sprint 2.5+). Only present on a freshly-
  // authenticated rebind — never returned from the public /hotspot/lookup
  // since lookup accepts a spoofable MAC and isn't an authentication event.
  token?: string;
  tokenExpiresAt?: string;
}

/**
 * Normalize a MAC to canonical storage form: lowercase, colon-separated.
 * Accepts AA-BB, AA:BB, AABB.CCDD, aabbccddeeff, etc. Returns null if
 * the input doesn't decode to 12 hex digits.
 */
export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/**
 * Returning-device auto-grant check. Called by the captive portal on
 * mount (before rendering tabs). Public endpoint — RATE-LIMIT at the
 * route layer to prevent MAC enumeration.
 */
export async function lookup(rawMac: string): Promise<LookupResult> {
  const mac = normalizeMac(rawMac);
  if (!mac) return { active: false };
  const r = await query<ActiveDevice>(
    `SELECT * FROM active_devices WHERE mac = $1 AND expires_at > now()`,
    [mac]
  );
  const dev = r.rows[0];
  if (!dev) return { active: false };
  // Touch last_seen so admin "recently active" lists are useful.
  query(`UPDATE active_devices SET last_seen = now() WHERE mac = $1`, [mac]).catch(() => {});
  const secondsRemaining = Math.max(0, Math.floor((new Date(dev.expires_at).getTime() - Date.now()) / 1000));
  return {
    active: true,
    username: mac,
    password: mac,
    validitySeconds: dev.session_timeout_seconds,
    secondsRemaining,
    rateLimit: dev.rate_limit,
    phone: dev.phone,
  };
}

/**
 * Quick Connect (operator-requested feature): look up an active session
 * by phone number directly, no SMS-OTP. If the phone has a live grant
 * on any MAC, copy the grant onto the caller's current MAC and connect.
 *
 * SECURITY TRADE-OFF: trusts knowledge of the phone number as proof of
 * ownership. Anyone who knows a customer's M-Pesa phone could ride the
 * plan from a different device. Mitigations:
 *   - Strict rate limit at the route layer (defense vs phone enumeration)
 *   - Async SMS notification to the phone ("device connected at HH:MM")
 *     so the customer can detect misuse and Forget their devices
 *   - Audit log so operator can spot abuse patterns
 *   - Always records the connecting MAC + IP + UA on auto_reconnect_log
 *
 * For high-security venues, disable this endpoint via env var and
 * fall back to the SMS-OTP rebind flow.
 */
export async function quickConnect(input: {
  phone: string;
  mac: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<LookupResult> {
  const phone = normalizeMsisdn(input.phone);
  const mac = normalizeMac(input.mac);
  if (!mac) {
    const tokens = await import('./tokens.js');
    await tokens.logAttempt({ method: 'manual', outcome: 'error', notes: 'invalid mac', phone, ip: input.ip, userAgent: input.userAgent });
    throw badRequest('invalid MAC');
  }

  return withTransaction(async (c) => {
    // Most-recent live grant for this phone.
    const g = await c.query<ActiveDevice>(
      `SELECT * FROM active_devices
        WHERE phone = $1 AND expires_at > now()
        ORDER BY last_seen DESC LIMIT 1`,
      [phone]
    );
    const src = g.rows[0];
    if (!src) {
      const tokens = await import('./tokens.js');
      await tokens.logAttempt({ method: 'manual', outcome: 'no_match', mac, phone, ip: input.ip, userAgent: input.userAgent });
      throw notFound('no active session for this phone — please pay first');
    }

    // Copy grant onto the caller's MAC.
    await c.query(
      `INSERT INTO active_devices (
         mac, expires_at, rate_limit, session_timeout_seconds, idle_timeout_seconds,
         source, phone, purchase_id, customer_id, rebound_from_mac
       ) VALUES ($1, $2, $3, $4, $5, 'rebind', $6, $7, $8, $9)
       ON CONFLICT (mac) DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         rate_limit = EXCLUDED.rate_limit,
         session_timeout_seconds = EXCLUDED.session_timeout_seconds,
         phone = EXCLUDED.phone,
         purchase_id = EXCLUDED.purchase_id,
         source = 'rebind',
         rebound_from_mac = EXCLUDED.rebound_from_mac,
         last_seen = now()`,
      [mac, src.expires_at, src.rate_limit, src.session_timeout_seconds,
       src.idle_timeout_seconds, src.phone, src.purchase_id, src.customer_id,
       src.mac === mac ? null : src.mac]
    );

    const tokens = await import('./tokens.js');
    await tokens.logAttempt({ method: 'manual', outcome: 'success', mac, phone, ip: input.ip, userAgent: input.userAgent });

    // Only SMS-alert when Quick Connect actually rebound the grant onto a
    // DIFFERENT device. When src.mac === mac, the customer is just re-using
    // Quick Connect from the same phone they already paid on — no security
    // event, no SMS needed (otherwise every refresh / re-test spams them
    // with a misleading "if it wasn't you, reply revoke" message).
    if (src.mac !== mac) {
      const last4 = mac.replace(/:/g, '').slice(-4);
      notify('sms', phone, `HUB Wi-Fi: device ${last4} just connected using your number. If this wasn't you, reply to revoke.`)
        .catch((e) => console.error('[quick-connect] sms notify failed:', e));
    }

    const secondsRemaining = Math.max(0, Math.floor((new Date(src.expires_at).getTime() - Date.now()) / 1000));
    return {
      active: true,
      username: mac,
      password: mac,
      validitySeconds: src.session_timeout_seconds,
      secondsRemaining,
      rateLimit: src.rate_limit,
      phone: src.phone,
    };
  });
}

/**
 * Start the SMS-OTP rebind flow. Generates a 6-digit code, stores it
 * with 5-min TTL, sends via SMS. Only generates a code if the phone
 * has a still-live grant on SOME mac — otherwise we'd be sending OTPs
 * to phones we can't actually rebind. That avoids being abused as a
 * generic SMS sender.
 */
export async function rebindStart(input: {
  phone: string;
  newMac: string;
  sourceIp?: string;
  userAgent?: string;
}): Promise<{ otpId: string; message: string }> {
  const phone = normalizeMsisdn(input.phone);
  const mac = normalizeMac(input.newMac);
  if (!mac) throw badRequest('invalid MAC address');

  // Check: does this phone have ANY live grant we could rebind?
  const r = await query<ActiveDevice>(
    `SELECT * FROM active_devices
      WHERE phone = $1 AND expires_at > now()
      ORDER BY last_seen DESC LIMIT 1`,
    [phone]
  );
  if (!r.rows[0]) {
    throw notFound('no active grant for this phone — purchase a plan first');
  }

  // Rate-limit: max 3 OTPs per phone in the last 10 minutes.
  const recent = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM hotspot_rebind_otps
      WHERE phone = $1 AND created_at > now() - interval '10 minutes'`,
    [phone]
  );
  if ((recent.rows[0]?.n ?? 0) >= 3) {
    throw badRequest('too many OTP requests — try again in 10 minutes');
  }

  const code = String(crypto.randomInt(100000, 1_000_000));
  const ins = await query<{ id: string }>(
    `INSERT INTO hotspot_rebind_otps (phone, code, new_mac, source_ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')
     RETURNING id`,
    [phone, code, mac, input.sourceIp ?? null, input.userAgent ?? null]
  );

  // Fire-and-forget SMS; failure here shouldn't break the API call.
  notify('sms', phone, `HUB Wi-Fi: your code is ${code}. Valid for 5 minutes.`)
    .catch((e) => console.error('[rebind] sms failed:', e));

  const last4 = phone.slice(-4);
  return {
    otpId: ins.rows[0].id,
    message: `OTP sent to phone ending ${last4}`,
  };
}

/**
 * Verify the OTP and clone the prior grant onto the new MAC. On success
 * the customer's new device is immediately authorized — next captive
 * lookup() will return active.
 */
export async function rebindVerify(input: {
  otpId: string;
  code: string;
  fingerprintHash?: string | null;
}): Promise<LookupResult> {
  return withTransaction(async (c) => {
    const r = await c.query<{
      id: string; phone: string; code: string; new_mac: string;
      attempts: number; max_attempts: number; expires_at: string;
      used_at: string | null;
    }>(
      `SELECT id, phone, code, new_mac, attempts, max_attempts, expires_at, used_at
         FROM hotspot_rebind_otps WHERE id = $1 FOR UPDATE`,
      [input.otpId]
    );
    const otp = r.rows[0];
    if (!otp) throw notFound('otp');
    if (otp.used_at) throw badRequest('otp already used');
    if (new Date(otp.expires_at) < new Date()) throw badRequest('otp expired');
    if (otp.attempts >= otp.max_attempts) throw badRequest('too many attempts');

    if (otp.code !== input.code.trim()) {
      await c.query(`UPDATE hotspot_rebind_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
      throw badRequest('incorrect code');
    }

    // Find the most recent live grant for the phone.
    const g = await c.query<ActiveDevice>(
      `SELECT * FROM active_devices
        WHERE phone = $1 AND expires_at > now()
        ORDER BY last_seen DESC LIMIT 1`,
      [otp.phone]
    );
    const src = g.rows[0];
    if (!src) throw badRequest('grant has expired since OTP was sent');

    // Copy the grant onto the new MAC. ON CONFLICT (mac) DO UPDATE so a
    // re-rebind to the same MAC just refreshes the row.
    await c.query(
      `INSERT INTO active_devices (
         mac, expires_at, rate_limit, session_timeout_seconds, idle_timeout_seconds,
         source, phone, purchase_id, customer_id, rebound_from_mac
       ) VALUES ($1, $2, $3, $4, $5, 'rebind', $6, $7, $8, $9)
       ON CONFLICT (mac) DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         rate_limit = EXCLUDED.rate_limit,
         session_timeout_seconds = EXCLUDED.session_timeout_seconds,
         phone = EXCLUDED.phone,
         purchase_id = EXCLUDED.purchase_id,
         source = 'rebind',
         rebound_from_mac = EXCLUDED.rebound_from_mac,
         last_seen = now()`,
      [
        otp.new_mac,
        src.expires_at,
        src.rate_limit,
        src.session_timeout_seconds,
        src.idle_timeout_seconds,
        src.phone,
        src.purchase_id,
        src.customer_id,
        src.mac,
      ]
    );

    await c.query(`UPDATE hotspot_rebind_otps SET used_at = now() WHERE id = $1`, [otp.id]);

    // Inline-mint a device token now that the OTP has proven phone
    // ownership. Replaces the deprecated /hotspot/issue-token endpoint
    // (which accepted a spoofable MAC from the body). Mint runs in the
    // same transaction so a token without a verified OTP is impossible.
    const tokens = await import('./tokens.js');
    const tok = await tokens.issueTokenInTx(c, {
      phone: src.phone!,
      mac: otp.new_mac,
      fingerprintHash: input.fingerprintHash ?? null,
    });

    const secondsRemaining = Math.max(0, Math.floor((new Date(src.expires_at).getTime() - Date.now()) / 1000));
    return {
      active: true,
      username: otp.new_mac!,
      password: otp.new_mac!,
      validitySeconds: src.session_timeout_seconds,
      secondsRemaining,
      rateLimit: src.rate_limit,
      phone: src.phone,
      token: tok.token,
      tokenExpiresAt: tok.expiresAt,
    };
  });
}

// ---------- Admin helpers ----------

export interface ListFilters {
  liveOnly?: boolean;
  phone?: string;
  limit?: number;
}

/**
 * Best-effort User-Agent → friendly device label. Doesn't pull in a
 * full UA-parser dependency — covers the common Kenyan device mix
 * (Android dominant, iPhones, occasional laptops) and falls back to
 * "Other" when nothing matches. The original UA stays in the response
 * for power users.
 */
export function deviceModelFromUa(ua: string | null | undefined): string {
  if (!ua) return '—';
  const s = ua;
  // iPhone / iPad / iPod
  if (/iPhone/i.test(s)) {
    const ios = /OS (\d+)[_.](\d+)/i.exec(s);
    return ios ? `iPhone · iOS ${ios[1]}.${ios[2]}` : 'iPhone';
  }
  if (/iPad/i.test(s))  return 'iPad';
  if (/iPod/i.test(s))  return 'iPod';
  // Android — try to surface manufacturer + model from the "(...; <model> Build/...)" segment.
  if (/Android/i.test(s)) {
    const ver = /Android (\d+(?:\.\d+)?)/i.exec(s);
    const m = /;\s*([^;)]+?)\s+Build\//i.exec(s) || /;\s*([^;)]+?)\)\s+AppleWebKit/i.exec(s);
    const model = m ? m[1].trim().replace(/\s+/g, ' ') : null;
    return [model || 'Android', ver ? `Android ${ver[1]}` : null].filter(Boolean).join(' · ');
  }
  // Desktop browsers
  if (/Windows NT/i.test(s)) return 'Windows · ' + (/Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : 'Browser');
  if (/Macintosh/i.test(s)) return 'macOS · ' + (/Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : 'Safari');
  if (/Linux/i.test(s))    return 'Linux · ' + (/Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : 'Browser');
  return 'Other';
}

export interface DeviceListRow extends ActiveDevice {
  // Joined enrichment for the admin Devices page. All nullable — voucher
  // grants and admin-issued grants have no hotspot_purchases row to join,
  // and pre-migration purchases have no user_agent.
  plan_name: string | null;
  plan_validity_days: number | null;
  data_cap_mb: number | null;
  amount_kes: number | null;
  stk_status: 'pending' | 'success' | 'failed' | 'expired' | null;
  stk_receipt: string | null;
  stk_failure_reason: string | null;
  stk_created_at: string | null;
  stk_completed_at: string | null;
  user_agent: string | null;
  device_model: string;                    // derived from user_agent
  seconds_remaining: number;
  checkout_request_id: string | null;
}

export async function listDevices(f: ListFilters): Promise<DeviceListRow[]> {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.liveOnly) where.push(`ad.expires_at > now()`);
  if (f.phone) { vals.push(f.phone); where.push(`ad.phone = $${vals.length}`); }
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  vals.push(limit);
  // LEFT JOIN keeps voucher / admin grants visible even though they have
  // no hotspot_purchases row. We pick the most recent purchase row for
  // the MAC's phone when ad.purchase_id is null (covers SMS-OTP rebinds
  // where active_devices.purchase_id was nulled on rebind copy).
  const sql = `
    SELECT
      ad.*,
      p.name              AS plan_name,
      p.validity_days     AS plan_validity_days,
      p.data_cap_mb       AS data_cap_mb,
      hp.checkout_request_id,
      hp.amount_kes,
      hp.status           AS stk_status,
      hp.receipt          AS stk_receipt,
      hp.failure_reason   AS stk_failure_reason,
      hp.user_agent,
      hp.created_at       AS stk_created_at,
      hp.completed_at     AS stk_completed_at,
      GREATEST(0, EXTRACT(EPOCH FROM (ad.expires_at - now()))::bigint)::int AS seconds_remaining
    FROM active_devices ad
    LEFT JOIN LATERAL (
      SELECT *
        FROM hotspot_purchases
       WHERE id = ad.purchase_id
          OR (ad.purchase_id IS NULL AND phone = ad.phone)
       ORDER BY created_at DESC
       LIMIT 1
    ) hp ON true
    LEFT JOIN plans p ON p.id = hp.plan_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ad.last_seen DESC
    LIMIT $${vals.length}`;
  const r = await query<any>(sql, vals);
  return r.rows.map((row: any) => ({
    ...row,
    device_model: deviceModelFromUa(row.user_agent),
  }));
}

export async function revoke(mac: string): Promise<void> {
  const m = normalizeMac(mac);
  if (!m) throw badRequest('invalid MAC');
  await query(`DELETE FROM active_devices WHERE mac = $1`, [m]);
}

/**
 * Rich session info for the customer-facing status page. Joins active_devices
 * to hotspot_purchases + plans to surface plan name, data cap, voucher code,
 * and current bytes-used (summed across all radacct rows for this MAC since
 * the device was first seen — handles the multi-session case where MikroTik
 * generates multiple Acct-Session-Ids during a long connection).
 */
export interface SessionInfo {
  planName: string | null;
  voucherId: string | null;
  expiresAt: string | null;
  secondsRemaining: number | null;
  rateLimit: string | null;
  dataCapMb: number | null;
  bytesUsed: number;
  phone: string | null;
}

export async function getSessionInfo(rawMac: string): Promise<SessionInfo | null> {
  const mac = normalizeMac(rawMac);
  if (!mac) return null;
  const r = await query<{
    expires_at: string | null;
    rate_limit: string | null;
    phone: string | null;
    plan_name: string | null;
    data_cap_mb: number | null;
    voucher_code: string | null;
    bytes_used: number;
  }>(
    `SELECT
       ad.expires_at,
       ad.rate_limit,
       ad.phone,
       p.name        AS plan_name,
       p.data_cap_mb AS data_cap_mb,
       v.code        AS voucher_code,
       COALESCE((
         SELECT SUM(COALESCE(acctinputoctets,0) + COALESCE(acctoutputoctets,0))
           FROM radacct
          WHERE LOWER(callingstationid) IN ($1, replace($1,':',''), replace($1,':','-'))
            AND acctstarttime >= ad.first_seen
       ), 0)::bigint AS bytes_used
       FROM active_devices ad
       LEFT JOIN hotspot_purchases hp ON hp.id = ad.purchase_id
       LEFT JOIN plans p              ON p.id = hp.plan_id
       LEFT JOIN vouchers v           ON v.code = hp.username
      WHERE ad.mac = $1
      LIMIT 1`,
    [mac]
  );
  const row = r.rows[0];
  if (!row) return null;
  const secondsRemaining = row.expires_at
    ? Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000))
    : null;
  return {
    planName: row.plan_name,
    voucherId: row.voucher_code,
    expiresAt: row.expires_at,
    secondsRemaining,
    rateLimit: row.rate_limit,
    dataCapMb: row.data_cap_mb,
    bytesUsed: Number(row.bytes_used) || 0,
    phone: row.phone,
  };
}
