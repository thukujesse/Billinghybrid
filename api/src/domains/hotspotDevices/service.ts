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

    const secondsRemaining = Math.max(0, Math.floor((new Date(src.expires_at).getTime() - Date.now()) / 1000));
    return {
      active: true,
      username: otp.new_mac,
      password: otp.new_mac,
      validitySeconds: src.session_timeout_seconds,
      secondsRemaining,
      rateLimit: src.rate_limit,
      phone: src.phone,
    };
  });
}

// ---------- Admin helpers ----------

export interface ListFilters {
  liveOnly?: boolean;
  phone?: string;
  limit?: number;
}

export async function listDevices(f: ListFilters): Promise<ActiveDevice[]> {
  const where: string[] = [];
  const vals: any[] = [];
  if (f.liveOnly) where.push(`expires_at > now()`);
  if (f.phone) { vals.push(f.phone); where.push(`phone = $${vals.length}`); }
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  vals.push(limit);
  const sql = `SELECT * FROM active_devices
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY last_seen DESC
                LIMIT $${vals.length}`;
  const r = await query<ActiveDevice>(sql, vals);
  return r.rows;
}

export async function revoke(mac: string): Promise<void> {
  const m = normalizeMac(mac);
  if (!m) throw badRequest('invalid MAC');
  await query(`DELETE FROM active_devices WHERE mac = $1`, [m]);
}
