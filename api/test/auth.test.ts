import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { signJwt, verifyJwt } from '../src/lib/jwt.js';
import { hashPassword, verifyPassword, generateOtp } from '../src/lib/password.js';
import { createUser, loginPassword, requestOtp, verifyOtp } from '../src/domains/auth/service.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';

const tag = Date.now().toString().slice(-7);

afterAll(async () => { await pool.end(); });

describe('jwt', () => {
  it('signs and verifies, rejects tampered/expired tokens', () => {
    const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 3600);
    const claims = verifyJwt(t, 'secret');
    expect(claims?.sub).toBe('u1');
    expect(claims?.role).toBe('admin');
    expect(verifyJwt(t, 'wrong-secret')).toBeNull();
    expect(verifyJwt(t + 'x', 'secret')).toBeNull();
    const expired = signJwt({ sub: 'u1', role: 'admin' }, 'secret', -10);
    expect(verifyJwt(expired, 'secret')).toBeNull();
  });
});

describe('password', () => {
  it('hashes and verifies', () => {
    const h = hashPassword('hunter2');
    expect(verifyPassword('hunter2', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
  it('generates numeric OTP of fixed length', () => {
    const c = generateOtp(6);
    expect(c).toMatch(/^\d{6}$/);
  });
});

describe('staff login', () => {
  it('logs in with valid credentials and rejects bad ones', async () => {
    const username = `staff_${tag}`;
    await createUser({ username, password: 'secret123', role: 'staff' });
    const { token, user } = await loginPassword(username, 'secret123');
    expect(user.role).toBe('staff');
    expect(verifyJwt(token, (await import('../src/config.js')).config.auth.jwtSecret)?.role).toBe('staff');
    await expect(loginPassword(username, 'nope')).rejects.toMatchObject({ status: 401 });
  });
});

describe('subscriber OTP login', () => {
  it('issues a subscriber token after correct code, rejects wrong code', async () => {
    const phone = `5${tag}01`;
    await createSubscriber({ full_name: 'OTP User', phone });
    const { devCode } = await requestOtp(phone);
    expect(devCode).toMatch(/^\d{6}$/);

    await expect(verifyOtp(phone, '000000')).rejects.toMatchObject({ status: 401 });
    const { token, subscriberId } = await verifyOtp(phone, devCode!);
    expect(subscriberId).toBeTruthy();
    expect(token.split('.').length).toBe(3);
  });
});
