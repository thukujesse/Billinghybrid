import { query } from '../../db/pool.js';
import { config } from '../../config.js';

export interface MpesaConfig {
  env: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  shortcode: string;
}

/** Public view of M-Pesa config — secrets are NEVER returned, only whether
 * they are set. Used by the dashboard to show "configured / not configured"
 * without leaking values back to the browser. */
export interface MpesaConfigPublic {
  env: 'sandbox' | 'production';
  shortcode: string;
  consumerKeySet: boolean;
  consumerSecretSet: boolean;
  passkeySet: boolean;
  simulated: boolean;
}

async function readSettings(prefix: string): Promise<Map<string, string>> {
  const r = await query<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key LIKE $1`,
    [`${prefix}%`]
  );
  return new Map(r.rows.map((x) => [x.key, x.value]));
}

/**
 * Resolve M-Pesa credentials. DB settings win; env vars are the fallback so
 * the app stays bootable on a fresh deploy before admin configures via UI.
 */
export async function getMpesaConfig(): Promise<MpesaConfig> {
  const map = await readSettings('mpesa.');
  return {
    env: ((map.get('mpesa.env') ?? config.mpesa.env) as 'sandbox' | 'production'),
    consumerKey: map.get('mpesa.consumer_key') ?? config.mpesa.consumerKey,
    consumerSecret: map.get('mpesa.consumer_secret') ?? config.mpesa.consumerSecret,
    passkey: map.get('mpesa.passkey') ?? config.mpesa.passkey,
    shortcode: map.get('mpesa.shortcode') ?? config.mpesa.shortcode,
  };
}

export async function getMpesaConfigPublic(): Promise<MpesaConfigPublic> {
  const c = await getMpesaConfig();
  return {
    env: c.env,
    shortcode: c.shortcode,
    consumerKeySet: !!c.consumerKey,
    consumerSecretSet: !!c.consumerSecret,
    passkeySet: !!c.passkey,
    simulated: !c.consumerKey || !c.consumerSecret || !c.passkey,
  };
}

/** True if any required M-Pesa credential is missing (env vars and DB both). */
export async function isMpesaSimulated(): Promise<boolean> {
  const c = await getMpesaConfig();
  return !c.consumerKey || !c.consumerSecret || !c.passkey;
}

// =====================================================================
// SMS provider settings — same DB-overrides-env pattern as M-Pesa above.
// =====================================================================

export type SmsProvider = 'africastalking' | 'bytwave';

export interface SmsConfig {
  provider: SmsProvider;
  africastalking: { username: string; apiKey: string; senderId: string };
  bytwave: { apiKey: string; endpoint: string; senderId: string; payloadFormat: 'json' | 'form' };
}

export interface SmsConfigPublic {
  provider: SmsProvider;
  africastalking: { username: string; senderId: string; apiKeySet: boolean };
  bytwave: { endpoint: string; senderId: string; payloadFormat: 'json' | 'form'; apiKeySet: boolean };
  simulated: boolean;
}

export async function getSmsConfig(): Promise<SmsConfig> {
  const map = await readSettings('sms.');
  const provider = (map.get('sms.provider') ?? config.sms.provider) as SmsProvider;
  return {
    provider,
    africastalking: {
      username: map.get('sms.at.username')   ?? config.sms.username,
      apiKey:   map.get('sms.at.api_key')    ?? config.sms.apiKey,
      senderId: map.get('sms.at.sender_id')  ?? config.sms.senderId,
    },
    bytwave: {
      apiKey:        map.get('sms.bytwave.api_key')         ?? config.sms.bytwave.apiKey,
      endpoint:      map.get('sms.bytwave.endpoint')        ?? config.sms.bytwave.endpoint,
      senderId:      map.get('sms.bytwave.sender_id')       ?? config.sms.bytwave.senderId,
      payloadFormat: ((map.get('sms.bytwave.payload_format') ?? config.sms.bytwave.payloadFormat) as 'json' | 'form'),
    },
  };
}

export async function getSmsConfigPublic(): Promise<SmsConfigPublic> {
  const c = await getSmsConfig();
  const simulated = c.provider === 'bytwave' ? !c.bytwave.apiKey : !c.africastalking.apiKey;
  return {
    provider: c.provider,
    africastalking: {
      username: c.africastalking.username,
      senderId: c.africastalking.senderId,
      apiKeySet: !!c.africastalking.apiKey,
    },
    bytwave: {
      endpoint: c.bytwave.endpoint,
      senderId: c.bytwave.senderId,
      payloadFormat: c.bytwave.payloadFormat,
      apiKeySet: !!c.bytwave.apiKey,
    },
    simulated,
  };
}

/** Resolver used by the notification service when sending. */
export async function isSmsSimulated(): Promise<boolean> {
  const c = await getSmsConfig();
  return c.provider === 'bytwave' ? !c.bytwave.apiKey : !c.africastalking.apiKey;
}

export async function setSmsConfig(
  input: {
    provider?: SmsProvider;
    africastalking?: Partial<SmsConfig['africastalking']>;
    bytwave?: Partial<SmsConfig['bytwave']>;
  },
  updatedBy?: string
): Promise<void> {
  const entries: Array<[string, string, boolean]> = [];
  if (input.provider !== undefined) entries.push(['sms.provider', input.provider, false]);
  if (input.africastalking?.username !== undefined) entries.push(['sms.at.username', input.africastalking.username, false]);
  if (input.africastalking?.apiKey   !== undefined) entries.push(['sms.at.api_key', input.africastalking.apiKey, true]);
  if (input.africastalking?.senderId !== undefined) entries.push(['sms.at.sender_id', input.africastalking.senderId, false]);
  if (input.bytwave?.apiKey        !== undefined) entries.push(['sms.bytwave.api_key', input.bytwave.apiKey, true]);
  if (input.bytwave?.endpoint      !== undefined) entries.push(['sms.bytwave.endpoint', input.bytwave.endpoint, false]);
  if (input.bytwave?.senderId      !== undefined) entries.push(['sms.bytwave.sender_id', input.bytwave.senderId, false]);
  if (input.bytwave?.payloadFormat !== undefined) entries.push(['sms.bytwave.payload_format', input.bytwave.payloadFormat, false]);

  for (const [key, value, isSecret] of entries) {
    if (value === '') {
      await query(`DELETE FROM settings WHERE key = $1`, [key]);
    } else {
      await query(
        `INSERT INTO settings (key, value, is_secret, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           is_secret = EXCLUDED.is_secret,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
        [key, value, isSecret, updatedBy ?? 'admin']
      );
    }
  }
}

export async function setMpesaConfig(
  input: Partial<MpesaConfig>,
  updatedBy?: string
): Promise<void> {
  const entries: Array<[string, string, boolean]> = [];
  if (input.env !== undefined) entries.push(['mpesa.env', input.env, false]);
  if (input.shortcode !== undefined) entries.push(['mpesa.shortcode', input.shortcode, false]);
  if (input.consumerKey !== undefined) entries.push(['mpesa.consumer_key', input.consumerKey, true]);
  if (input.consumerSecret !== undefined) entries.push(['mpesa.consumer_secret', input.consumerSecret, true]);
  if (input.passkey !== undefined) entries.push(['mpesa.passkey', input.passkey, true]);

  for (const [key, value, isSecret] of entries) {
    if (value === '') {
      // Empty string means "clear this setting" — falls back to env var.
      await query(`DELETE FROM settings WHERE key = $1`, [key]);
    } else {
      await query(
        `INSERT INTO settings (key, value, is_secret, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value,
           is_secret = EXCLUDED.is_secret,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by`,
        [key, value, isSecret, updatedBy ?? 'admin']
      );
    }
  }
}
