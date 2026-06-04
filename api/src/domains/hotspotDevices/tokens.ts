/**
 * Device token: silent re-auth that survives MAC randomization.
 *
 * Flow:
 *   First successful auth (voucher / pay / SMS-OTP rebind / MAC lookup)
 *     -> portal calls issueToken({phone, mac, fingerprintHash})
 *     -> portal stores RAW token in localStorage + a Secure cookie.
 *   Future connections, before payment UI is shown:
 *     -> portal calls tryAutoReconnect({rawToken, fingerprintHash, newMac})
 *     -> server hashes the token, looks up the phone, finds the most
 *        recent live grant for that phone, copies it onto the new MAC,
 *        ROTATES the token, returns active=true + the new token.
 *
 * Security:
 *   - Raw token is 32 bytes from crypto.randomBytes, base64url-encoded.
 *   - DB stores SHA-256 of the raw token only; a DB-only leak can't
 *     replay tokens since the raw value isn't there.
 *   - Token rotates on every successful use (issues new token, revokes
 *     old). Limits the window a stolen token is useful.
 *   - Fingerprint mismatch is logged but doesn't outright deny — the
 *     fingerprint is fragile (browser updates change it). Operator can
 *     check the log if a token is being used from an unexpected device.
 *   - Token never grants free access on its own. It proves "I'm the
 *     same customer"; the customer's PLAN still has to be live (we
 *     check active_devices for them by phone). If the plan ended,
 *     auto-reconnect returns active=false and the customer pays.
 */
import crypto from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { normalizeMac } from './service.js';
import { normalizeMsisdn } from '../payments/daraja.js';

export interface IssueInput {
  phone: string;
  customerId?: string | null;
  mac?: string | null;
  fingerprintHash?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Token lifetime; defaults to 1 year. */
  ttlDays?: number;
}

export interface IssueResult {
  token: string;          // raw token — return ONCE to caller, never persisted
  tokenId: string;
  expiresAt: string;
}

export interface AutoReconnectInput {
  rawToken: string;
  fingerprintHash?: string | null;
  newMac: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AutoReconnectResult {
  active: boolean;
  // present on success — credentials to submit to MikroTik
  username?: string;
  password?: string;
  validitySeconds?: number;
  secondsRemaining?: number;
  rateLimit?: string | null;
  phone?: string | null;
  // ROTATED token; portal must overwrite its stored token with this
  token?: string;
  tokenExpiresAt?: string;
  // reason when active=false (for portal UX / telemetry)
  reason?: 'no_match' | 'expired' | 'revoked' | 'grant_expired' | 'rate_limited';
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function newRawToken(): string {
  // 32 bytes → 43-char base64url (no padding). Plenty of entropy.
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Mint a new device token. Caller must already have established that
 * `phone` legitimately owns the connection (just paid, voucher redeemed
 * on this MAC, OTP rebind verified, or MAC lookup matched a grant for
 * this phone). We don't re-verify here.
 */
export async function issueToken(input: IssueInput): Promise<IssueResult> {
  const phone = normalizeMsisdn(input.phone);
  const mac = input.mac ? normalizeMac(input.mac) : null;
  const ttlDays = input.ttlDays ?? 365;
  const raw = newRawToken();
  const r = await query<{ id: string; expires_at: string }>(
    `INSERT INTO device_tokens (
       token_hash, phone, customer_id, fingerprint_hash,
       last_mac, last_ip, last_user_agent, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' days')::interval)
     RETURNING id, expires_at`,
    [
      hashToken(raw),
      phone,
      input.customerId ?? null,
      input.fingerprintHash ?? null,
      mac,
      input.ip ?? null,
      input.userAgent ?? null,
      String(ttlDays),
    ]
  );
  return {
    token: raw,
    tokenId: r.rows[0].id,
    expiresAt: r.rows[0].expires_at,
  };
}

interface TokenRow {
  id: string;
  phone: string;
  customer_id: string | null;
  fingerprint_hash: string | null;
  expires_at: string;
  revoked_at: string | null;
}

interface ActiveGrant {
  mac: string;
  expires_at: string;
  rate_limit: string | null;
  session_timeout_seconds: number;
  idle_timeout_seconds: number;
  phone: string | null;
  purchase_id: string | null;
  customer_id: string | null;
}

/**
 * Validate a presented token, find the customer's live grant, copy it
 * onto the new MAC, rotate the token. Returns active=false (with reason)
 * for any failure — never throws on "expected" misses, since this is
 * called speculatively on every captive load.
 */
export async function tryAutoReconnect(input: AutoReconnectInput): Promise<AutoReconnectResult> {
  const mac = normalizeMac(input.newMac);
  if (!mac) {
    await logAttempt({ method: 'token', outcome: 'error', notes: 'invalid mac', ip: input.ip, userAgent: input.userAgent });
    return { active: false, reason: 'no_match' };
  }
  if (!input.rawToken || input.rawToken.length < 20) {
    return { active: false, reason: 'no_match' };
  }
  const tokenHash = hashToken(input.rawToken);

  return withTransaction(async (c) => {
    const r = await c.query<TokenRow>(
      `SELECT id, phone, customer_id, fingerprint_hash, expires_at, revoked_at
         FROM device_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash]
    );
    const tok = r.rows[0];
    if (!tok) {
      await logAttempt({ method: 'token', outcome: 'no_match', mac, ip: input.ip, userAgent: input.userAgent });
      return { active: false, reason: 'no_match' };
    }
    if (tok.revoked_at) {
      await logAttempt({ method: 'token', outcome: 'revoked', mac, phone: tok.phone, tokenId: tok.id, ip: input.ip, userAgent: input.userAgent });
      return { active: false, reason: 'revoked' };
    }
    if (new Date(tok.expires_at) < new Date()) {
      await logAttempt({ method: 'token', outcome: 'expired', mac, phone: tok.phone, tokenId: tok.id, ip: input.ip, userAgent: input.userAgent });
      return { active: false, reason: 'expired' };
    }

    // Fingerprint check is advisory: log mismatch but still proceed.
    // Browser updates legitimately change fingerprints; refusing here
    // would lock customers out for normal OS upgrades.
    const fpMatch = !!(input.fingerprintHash && tok.fingerprint_hash && input.fingerprintHash === tok.fingerprint_hash);

    // Find the most recent live grant for this phone.
    const g = await c.query<ActiveGrant>(
      `SELECT mac, expires_at, rate_limit, session_timeout_seconds, idle_timeout_seconds,
              phone, purchase_id, customer_id
         FROM active_devices
        WHERE phone = $1 AND expires_at > now()
        ORDER BY last_seen DESC LIMIT 1`,
      [tok.phone]
    );
    const src = g.rows[0];
    if (!src) {
      await logAttempt({
        method: 'token', outcome: 'grant_expired', mac, phone: tok.phone, tokenId: tok.id,
        fingerprintMatch: tok.fingerprint_hash ? fpMatch : null, ip: input.ip, userAgent: input.userAgent,
      });
      return { active: false, reason: 'grant_expired' };
    }

    // Copy the grant onto the new MAC (same shape as rebindVerify).
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
        mac,
        src.expires_at,
        src.rate_limit,
        src.session_timeout_seconds,
        src.idle_timeout_seconds,
        src.phone,
        src.purchase_id,
        src.customer_id,
        src.mac === mac ? null : src.mac,
      ]
    );

    // Rotate token: revoke this one, issue a fresh one. Same row would
    // be simpler but rotation+log is cleaner — we keep history of which
    // token was used when.
    const newRaw = newRawToken();
    await c.query(
      `UPDATE device_tokens
          SET revoked_at = now(), revoke_reason = 'rotated', use_count = use_count + 1
        WHERE id = $1`,
      [tok.id]
    );
    const nt = await c.query<{ id: string; expires_at: string }>(
      `INSERT INTO device_tokens (
         token_hash, phone, customer_id, fingerprint_hash,
         last_mac, last_ip, last_user_agent, expires_at, use_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '365 days', 1)
       RETURNING id, expires_at`,
      [
        hashToken(newRaw),
        tok.phone,
        tok.customer_id,
        // Carry forward whichever fingerprint we have most recently seen.
        input.fingerprintHash ?? tok.fingerprint_hash,
        mac,
        input.ip ?? null,
        input.userAgent ?? null,
      ]
    );

    await logAttempt({
      method: 'token', outcome: 'success', mac, phone: tok.phone, tokenId: nt.rows[0].id,
      fingerprintMatch: tok.fingerprint_hash ? fpMatch : null, ip: input.ip, userAgent: input.userAgent,
    });

    const secondsRemaining = Math.max(0, Math.floor((new Date(src.expires_at).getTime() - Date.now()) / 1000));
    return {
      active: true,
      username: mac,
      password: mac,
      validitySeconds: src.session_timeout_seconds,
      secondsRemaining,
      rateLimit: src.rate_limit,
      phone: src.phone,
      token: newRaw,
      tokenExpiresAt: nt.rows[0].expires_at,
    };
  });
}

/**
 * Customer-driven revoke: "Forget this device". Wipes the token row
 * (still leaves the audit log entries). Caller must clear localStorage
 * and any cookie on their end.
 */
export async function forgetDevice(rawToken: string, reason = 'user_revoked'): Promise<{ revoked: boolean }> {
  if (!rawToken) return { revoked: false };
  const r = await query<{ id: string; phone: string }>(
    `UPDATE device_tokens
        SET revoked_at = now(), revoke_reason = $2
      WHERE token_hash = $1 AND revoked_at IS NULL
      RETURNING id, phone`,
    [hashToken(rawToken), reason]
  );
  return { revoked: r.rowCount! > 0 };
}

/** Admin: revoke every token for a phone (e.g., on customer support request). */
export async function forgetAllForPhone(phone: string, reason = 'admin_revoked'): Promise<number> {
  const p = normalizeMsisdn(phone);
  const r = await query(
    `UPDATE device_tokens
        SET revoked_at = now(), revoke_reason = $2
      WHERE phone = $1 AND revoked_at IS NULL`,
    [p, reason]
  );
  return r.rowCount ?? 0;
}

interface LogInput {
  method: 'mac' | 'token' | 'fingerprint' | 'sms_otp' | 'manual';
  outcome: 'success' | 'no_match' | 'expired' | 'revoked' | 'rate_limited' | 'grant_expired' | 'fingerprint_mismatch' | 'error';
  mac?: string | null;
  phone?: string | null;
  tokenId?: string | null;
  fingerprintMatch?: boolean | null;
  ip?: string | null;
  userAgent?: string | null;
  notes?: string | null;
}

/**
 * Fire-and-forget audit log. Errors are swallowed — observability must
 * never break the hot path.
 */
export async function logAttempt(i: LogInput): Promise<void> {
  try {
    await query(
      `INSERT INTO auto_reconnect_log (
         method, outcome, mac, phone, token_id, fingerprint_match,
         source_ip, user_agent, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        i.method, i.outcome, i.mac ?? null, i.phone ?? null, i.tokenId ?? null,
        i.fingerprintMatch ?? null, i.ip ?? null, i.userAgent ?? null, i.notes ?? null,
      ]
    );
  } catch (e) {
    console.error('[auto-reconnect] log insert failed:', e);
  }
}

export interface LogStats {
  windowHours: number;
  total: number;
  byMethodOutcome: Record<string, number>;
  // Quick rollups for ops dashboards.
  successRate: number;
  tokenUses: number;
  fingerprintMismatches: number;
}

export async function recentStats(windowHours = 24): Promise<LogStats> {
  const r = await query<{ method: string; outcome: string; n: number }>(
    `SELECT method, outcome, COUNT(*)::int AS n
       FROM auto_reconnect_log
      WHERE created_at > now() - ($1 || ' hours')::interval
      GROUP BY method, outcome`,
    [String(windowHours)]
  );
  const byMethodOutcome: Record<string, number> = {};
  let total = 0;
  let successes = 0;
  let tokenUses = 0;
  let fpMismatches = 0;
  for (const row of r.rows) {
    const key = `${row.method}.${row.outcome}`;
    byMethodOutcome[key] = row.n;
    total += row.n;
    if (row.outcome === 'success') successes += row.n;
    if (row.method === 'token') tokenUses += row.n;
    if (row.outcome === 'fingerprint_mismatch') fpMismatches += row.n;
  }
  return {
    windowHours,
    total,
    byMethodOutcome,
    successRate: total > 0 ? Math.round((successes / total) * 1000) / 10 : 0,
    tokenUses,
    fingerprintMismatches: fpMismatches,
  };
}

export interface LogEntry {
  id: string;
  created_at: string;
  method: string;
  outcome: string;
  mac: string | null;
  phone: string | null;
  token_id: string | null;
  fingerprint_match: boolean | null;
  source_ip: string | null;
  user_agent: string | null;
  notes: string | null;
}

export async function listRecent(limit = 200, phone?: string): Promise<LogEntry[]> {
  const cap = Math.min(Math.max(limit, 1), 1000);
  if (phone) {
    const r = await query<LogEntry>(
      `SELECT * FROM auto_reconnect_log WHERE phone = $1 ORDER BY created_at DESC LIMIT $2`,
      [normalizeMsisdn(phone), cap]
    );
    return r.rows;
  }
  const r = await query<LogEntry>(
    `SELECT * FROM auto_reconnect_log ORDER BY created_at DESC LIMIT $1`,
    [cap]
  );
  return r.rows;
}
