import { describe, it, expect, afterAll } from 'vitest';
import { t } from '../src/lib/i18n.js';
import { pool } from '../src/db/pool.js';
import { createSubscriber, setLanguage, languageOf } from '../src/domains/subscribers/service.js';

const tag = Date.now().toString().slice(-7);
afterAll(async () => { await pool.end(); });

describe('i18n t()', () => {
  it('returns Swahili and English copy with interpolation', () => {
    expect(t('en', 'payment.received')).toBe('Payment received. Thank you!');
    expect(t('sw', 'payment.received')).toBe('Malipo yamepokelewa. Asante!');
    expect(t('sw', 'fup.threshold', { pct: 80 })).toContain('asilimia 80');
    expect(t('en', 'otp.code', { code: '123456', minutes: 5 })).toBe('Your login code is 123456. It expires in 5 minutes.');
  });

  it('falls back to English, then the raw key', () => {
    // unknown locale -> english
    expect(t('fr' as any, 'plan.active')).toBe('Your plan is active. Thank you!');
    // unknown key -> key itself
    expect(t('sw', 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('leaves unknown placeholders intact', () => {
    expect(t('en', 'plan.changed', {})).toContain('{verb}');
  });
});

describe('subscriber language preference', () => {
  it('defaults to en and can be set to sw', async () => {
    const sub = await createSubscriber({ full_name: 'Lang User', phone: `4${tag}01` });
    expect(sub.language).toBe('en');
    await setLanguage(sub.id, 'sw');
    expect(await languageOf(sub.id)).toBe('sw');
  });

  it('honors language at creation time', async () => {
    const sub = await createSubscriber({ full_name: 'Swahili User', phone: `4${tag}02`, language: 'sw' });
    expect(sub.language).toBe('sw');
  });
});
