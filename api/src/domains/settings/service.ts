import { query } from '../../db/pool.js';
import { config } from '../../config.js';

// How an ISP collects from hotspot customers:
//   stk      — Safaricom STK push (own Daraja paybill: key/secret/passkey)
//   paybill  — own Paybill, no API: customer pays paybill, account = reference
//   till     — own Till (Buy Goods), no API: customer pays till, account = reference
//   bank     — bank paybill + account name (e.g. Equity/KCB; verified via IPN)
//   intasend — IntaSend aggregator (settles to bank, has webhook)
//   kopokopo — Kopo Kopo aggregator (settles to bank/till, has webhook)
export type CollectionMethod = 'stk' | 'paybill' | 'till' | 'bank' | 'intasend' | 'kopokopo';

export interface MpesaConfig {
  env: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  passkey: string;
  shortcode: string;       // paybill number (stk / paybill / bank)
  till: string;            // till / Buy-Goods number (till method)
  accountName: string;     // bank account name (bank method)
  collectionMethod: CollectionMethod;
}

/** Public view of M-Pesa config — secrets are NEVER returned, only whether
 * they are set. Used by the dashboard to show "configured / not configured"
 * without leaking values back to the browser. */
export interface MpesaConfigPublic {
  env: 'sandbox' | 'production';
  shortcode: string;
  till: string;
  accountName: string;
  consumerKeySet: boolean;
  consumerSecretSet: boolean;
  passkeySet: boolean;
  simulated: boolean;
  collectionMethod: CollectionMethod;
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
  // Legacy 'c2b' rows map to the new 'paybill' method.
  const rawMethod = map.get('mpesa.collection_method') ?? 'stk';
  const collectionMethod = (rawMethod === 'c2b' ? 'paybill' : rawMethod) as CollectionMethod;
  return {
    env: ((map.get('mpesa.env') ?? config.mpesa.env) as 'sandbox' | 'production'),
    consumerKey: map.get('mpesa.consumer_key') ?? config.mpesa.consumerKey,
    consumerSecret: map.get('mpesa.consumer_secret') ?? config.mpesa.consumerSecret,
    passkey: map.get('mpesa.passkey') ?? config.mpesa.passkey,
    shortcode: map.get('mpesa.shortcode') ?? config.mpesa.shortcode,
    till: map.get('mpesa.till') ?? '',
    accountName: map.get('mpesa.account_name') ?? '',
    collectionMethod,
  };
}

export async function getMpesaConfigPublic(): Promise<MpesaConfigPublic> {
  const c = await getMpesaConfig();
  return {
    env: c.env,
    shortcode: c.shortcode,
    till: c.till,
    accountName: c.accountName,
    consumerKeySet: !!c.consumerKey,
    consumerSecretSet: !!c.consumerSecret,
    passkeySet: !!c.passkey,
    simulated: !c.consumerKey || !c.consumerSecret || !c.passkey,
    collectionMethod: c.collectionMethod,
  };
}

/** True if any required M-Pesa credential is missing (env vars and DB both). */
export async function isMpesaSimulated(): Promise<boolean> {
  const c = await getMpesaConfig();
  return !c.consumerKey || !c.consumerSecret || !c.passkey;
}

// =====================================================================
// IntaSend aggregator — collects M-Pesa (STK / paybill) + cards without
// your own Daraja paybill. Same DB-overrides-env pattern as M-Pesa.
// =====================================================================

export interface IntasendConfig {
  env: 'sandbox' | 'live';
  publicKey: string;
  secretKey: string;
  /** Webhook 'challenge' string set in the IntaSend dashboard — proves a
   *  webhook POST is genuinely from IntaSend. */
  challenge: string;
}

export interface IntasendConfigPublic {
  env: 'sandbox' | 'live';
  publicKeySet: boolean;
  secretKeySet: boolean;
  challengeSet: boolean;
  configured: boolean;
}

export async function getIntasendConfig(): Promise<IntasendConfig> {
  const map = await readSettings('intasend.');
  return {
    env: ((map.get('intasend.env') ?? process.env.INTASEND_ENV ?? 'sandbox') as 'sandbox' | 'live'),
    publicKey: map.get('intasend.public_key') ?? process.env.INTASEND_PUBLIC_KEY ?? '',
    secretKey: map.get('intasend.secret_key') ?? process.env.INTASEND_SECRET_KEY ?? '',
    challenge: map.get('intasend.challenge') ?? process.env.INTASEND_CHALLENGE ?? '',
  };
}

export async function getIntasendConfigPublic(): Promise<IntasendConfigPublic> {
  const c = await getIntasendConfig();
  return {
    env: c.env,
    publicKeySet: !!c.publicKey,
    secretKeySet: !!c.secretKey,
    challengeSet: !!c.challenge,
    configured: !!c.secretKey,
  };
}

export async function setIntasendConfig(
  input: Partial<IntasendConfig>,
  updatedBy?: string
): Promise<void> {
  const entries: Array<[string, string, boolean]> = [];
  if (input.env !== undefined) entries.push(['intasend.env', input.env, false]);
  if (input.publicKey !== undefined) entries.push(['intasend.public_key', input.publicKey, false]);
  if (input.secretKey !== undefined) entries.push(['intasend.secret_key', input.secretKey, true]);
  if (input.challenge !== undefined) entries.push(['intasend.challenge', input.challenge, true]);

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

// =====================================================================
// Kopo Kopo aggregator — collect M-Pesa via STK (Receive Payments) without
// your own Daraja paybill; settles to your K2 till/bank. Same pattern as above.
// =====================================================================

export interface KopokopoConfig {
  env: 'sandbox' | 'live';
  clientId: string;
  clientSecret: string;
  tillNumber: string;   // your K2 till (head office / store)
  apiKey: string;       // webhook signing secret from the K2 dashboard
}

export interface KopokopoConfigPublic {
  env: 'sandbox' | 'live';
  tillNumber: string;
  clientIdSet: boolean;
  clientSecretSet: boolean;
  apiKeySet: boolean;
  configured: boolean;
}

export async function getKopokopoConfig(): Promise<KopokopoConfig> {
  const map = await readSettings('kopokopo.');
  return {
    env: ((map.get('kopokopo.env') ?? process.env.KOPOKOPO_ENV ?? 'sandbox') as 'sandbox' | 'live'),
    clientId: map.get('kopokopo.client_id') ?? process.env.KOPOKOPO_CLIENT_ID ?? '',
    clientSecret: map.get('kopokopo.client_secret') ?? process.env.KOPOKOPO_CLIENT_SECRET ?? '',
    tillNumber: map.get('kopokopo.till') ?? process.env.KOPOKOPO_TILL ?? '',
    apiKey: map.get('kopokopo.api_key') ?? process.env.KOPOKOPO_API_KEY ?? '',
  };
}

export async function getKopokopoConfigPublic(): Promise<KopokopoConfigPublic> {
  const c = await getKopokopoConfig();
  return {
    env: c.env,
    tillNumber: c.tillNumber,
    clientIdSet: !!c.clientId,
    clientSecretSet: !!c.clientSecret,
    apiKeySet: !!c.apiKey,
    configured: !!c.clientId && !!c.clientSecret,
  };
}

export async function setKopokopoConfig(input: Partial<KopokopoConfig>, updatedBy?: string): Promise<void> {
  const entries: Array<[string, string, boolean]> = [];
  if (input.env !== undefined) entries.push(['kopokopo.env', input.env, false]);
  if (input.clientId !== undefined) entries.push(['kopokopo.client_id', input.clientId.trim(), true]);
  if (input.clientSecret !== undefined) entries.push(['kopokopo.client_secret', input.clientSecret.trim(), true]);
  if (input.tillNumber !== undefined) entries.push(['kopokopo.till', input.tillNumber.trim(), false]);
  if (input.apiKey !== undefined) entries.push(['kopokopo.api_key', input.apiKey.trim(), true]);

  for (const [key, value, isSecret] of entries) {
    if (value === '') {
      await query(`DELETE FROM settings WHERE key = $1`, [key]);
    } else {
      await query(
        `INSERT INTO settings (key, value, is_secret, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, value, isSecret, updatedBy ?? 'admin']
      );
    }
  }
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
  // Trim pasted credentials — a stray leading/trailing space in the shortcode or
  // keys silently breaks Daraja ("Invalid BusinessShortCode" / auth failures).
  if (input.env !== undefined) entries.push(['mpesa.env', input.env, false]);
  if (input.shortcode !== undefined) entries.push(['mpesa.shortcode', input.shortcode.trim(), false]);
  if (input.till !== undefined) entries.push(['mpesa.till', input.till.trim(), false]);
  if (input.accountName !== undefined) entries.push(['mpesa.account_name', input.accountName.trim(), false]);
  if (input.consumerKey !== undefined) entries.push(['mpesa.consumer_key', input.consumerKey.trim(), true]);
  if (input.consumerSecret !== undefined) entries.push(['mpesa.consumer_secret', input.consumerSecret.trim(), true]);
  if (input.passkey !== undefined) entries.push(['mpesa.passkey', input.passkey.trim(), true]);
  if (input.collectionMethod !== undefined) entries.push(['mpesa.collection_method', input.collectionMethod, false]);

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
