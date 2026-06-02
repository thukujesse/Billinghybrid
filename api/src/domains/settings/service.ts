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
