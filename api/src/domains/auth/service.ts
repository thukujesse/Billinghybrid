import { query } from '../../db/pool.js';
import { config } from '../../config.js';
import { badRequest, conflict, notFound, AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword, generateOtp } from '../../lib/password.js';
import { signJwt } from '../../lib/jwt.js';
import { notifications } from '../notifications/service.js';
import { listSubscribers } from '../subscribers/service.js';
import { t } from '../../lib/i18n.js';

export type Role = 'admin' | 'staff' | 'reseller' | 'subscriber';

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
