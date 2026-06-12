import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { badRequest, conflict, notFound, AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword, generateOtp } from '../../lib/password.js';
import { signJwt } from '../../lib/jwt.js';
import { notifications } from '../notifications/service.js';
import { listSubscribers } from '../subscribers/service.js';
import { t } from '../../lib/i18n.js';

export type Role = 'admin' | 'staff' | 'reseller' | 'subscriber' | 'customer';

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'staff' | 'reseller';
  reseller_id: string | null;
  active: boolean;
}

function unauthorized(msg: string) {
  return new AppError(401, 'unauthorized', msg);
}

function issueToken(sub: string, role: Role, extra: Record<string, unknown> = {}): string {
  return signJwt({ sub, role, ...extra }, config.auth.jwtSecret, config.auth.jwtTtlHours * 3600);
}

/**
 * Mint a short-lived ADMIN token a platform operator uses to impersonate a
 * tenant. requireAuth only checks the signature + role (not DB membership), and
 * tenant routing is by Host — so presenting this on the tenant's subdomain logs
 * the operator into that tenant as admin. NB: the JWT secret is shared across
 * tenants by design, which is what makes this (and cross-tenant trust) possible.
 */
export function impersonationToken(tenantSlug: string, operator: string): string {
  return signJwt(
    { sub: `imp:${operator}`, role: 'admin', username: `operator → ${tenantSlug}`, imp: true, tenant: tenantSlug },
    config.auth.jwtSecret,
    30 * 60 // 30 minutes
  );
}

// --------------------------- Staff users ----------------------------

export async function createUser(input: {
  username: string;
  password: string;
  role?: 'admin' | 'staff' | 'reseller';
  reseller_id?: string;
}): Promise<User> {
  if (input.password.length < 6) throw badRequest('password must be at least 6 characters');
  try {
    const r = await query<User>(
      `INSERT INTO users (username, password_hash, role, reseller_id)
       VALUES ($1,$2,$3,$4)
       RETURNING id, username, role, reseller_id, active`,
      [input.username.toLowerCase(), hashPassword(input.password), input.role ?? 'staff', input.reseller_id ?? null]
    );
    return r.rows[0];
  } catch (err: any) {
    if (err?.code === '23505') throw conflict('username already exists');
    throw err;
  }
}

/** First-run setup: true when no operator accounts exist yet, so the login
 *  page can offer "create the first admin" instead of a sign-in form. */
export async function setupStatus(): Promise<{ needsSetup: boolean }> {
  const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users`);
  return { needsSetup: (r.rows[0]?.n ?? 0) === 0 };
}

/** Bootstrap signup — creates the FIRST admin and signs them in. Refuses once
 *  any account exists (after that, an admin invites staff via createUser). */
export async function registerFirstAdmin(username: string, password: string): Promise<{ token: string; user: User }> {
  const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users`);
  if ((r.rows[0]?.n ?? 0) > 0) throw conflict('setup already complete — ask an admin to create your account');
  const user = await createUser({ username, password, role: 'admin' });
  const token = issueToken(user.id, user.role, { username: user.username });
  return { token, user };
}

export async function loginPassword(username: string, password: string): Promise<{ token: string; user: User }> {
  const r = await query(
    `SELECT * FROM users WHERE username = $1`,
    [username.toLowerCase()]
  );
  const user = r.rows[0];
  // Constant-ish failure path: verify against a dummy hash isn't necessary here,
  // but we avoid leaking which half failed.
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    throw unauthorized('invalid credentials');
  }
  const token = issueToken(user.id, user.role, { username: user.username });
  return { token, user: { id: user.id, username: user.username, role: user.role, reseller_id: user.reseller_id, active: user.active } };
}

// ----------------------- Subscriber OTP login -----------------------

export async function requestOtp(phone: string): Promise<{ sent: boolean; devCode?: string }> {
  const code = generateOtp(6);
  const expires = new Date(Date.now() + config.auth.otpTtlMinutes * 60_000);
  await query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [phone, hashPassword(code), expires.toISOString()]
  );
  // Localize the OTP message to the subscriber's language if we know them.
  const match = (await listSubscribers()).find((s) => s.phone === phone);
  const lang = match?.language ?? 'en';
  await notifications.sms(phone, t(lang, 'otp.code', { code, minutes: config.auth.otpTtlMinutes }));
  // In dev (auth disabled) we surface the code to make the flow testable.
  return { sent: true, ...(config.auth.enabled ? {} : { devCode: code }) };
}

export async function verifyOtp(phone: string, code: string): Promise<{ token: string; subscriberId: string }> {
  const r = await query(
    `SELECT * FROM otp_codes
     WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  const otp = r.rows[0];
  if (!otp) throw unauthorized('no valid code — request a new one');
  if (otp.attempts >= config.auth.otpMaxAttempts) throw unauthorized('too many attempts — request a new code');

  if (!verifyPassword(code, otp.code_hash)) {
    await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    throw unauthorized('incorrect code');
  }
  await query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [otp.id]);

  const matches = await listSubscribers().then((all) => all.filter((s) => s.phone === phone));
  if (!matches.length) throw notFound('subscriber for this phone');
  const subscriberId = matches[0].id;
  const token = issueToken(subscriberId, 'subscriber', { phone });
  return { token, subscriberId };
}

// ----------------------- Customer (PPPoE) portal OTP ------------------
// Same OTP storage as subscribers — distinguished by which table we look
// up at verify time. The phone must already exist on customers.phone;
// if not, requestCustomerOtp returns sent=false so we don't double as an
// SMS abuse surface for phones we have no relationship with.

export async function requestCustomerOtp(rawPhone: string): Promise<{ sent: boolean; devCode?: string }> {
  const { findCustomerByPhone } = await import('../customers/service.js');
  const customer = await findCustomerByPhone(rawPhone);
  if (!customer || !customer.phone) {
    // Don't reveal whether the phone exists in our system — just return
    // sent=true to make enumeration uninformative. (We still don't actually
    // SMS unknown phones — only the storage step is skipped.)
    return { sent: true };
  }
  const code = generateOtp(6);
  const expires = new Date(Date.now() + config.auth.otpTtlMinutes * 60_000);
  await query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [customer.phone, hashPassword(code), expires.toISOString()]
  );
  await notifications.sms(customer.phone, t('en', 'otp.code', { code, minutes: config.auth.otpTtlMinutes }));
  return { sent: true, ...(config.auth.enabled ? {} : { devCode: code }) };
}

export async function verifyCustomerOtp(rawPhone: string, code: string): Promise<{ token: string; customerId: string }> {
  const { findCustomerByPhone } = await import('../customers/service.js');
  const customer = await findCustomerByPhone(rawPhone);
  if (!customer || !customer.phone) throw notFound('account for this phone');
  const phone = customer.phone;

  const r = await query(
    `SELECT * FROM otp_codes
      WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  const otp = r.rows[0];
  if (!otp) throw unauthorized('no valid code — request a new one');
  if (otp.attempts >= config.auth.otpMaxAttempts) throw unauthorized('too many attempts — request a new code');

  if (!verifyPassword(code, otp.code_hash)) {
    await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    throw unauthorized('incorrect code');
  }
  await query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [otp.id]);

  const token = issueToken(customer.id, 'customer', { phone });
  return { token, customerId: customer.id };
}
