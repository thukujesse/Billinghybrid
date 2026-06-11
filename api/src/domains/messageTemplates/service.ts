/**
 * Customer-message templates. Defaults live here (matching the previously
 * hard-coded texts) so behaviour is unchanged until an operator edits one. The
 * message_templates table holds only overrides. Each event is defined per
 * audience ('pppoe' | 'hotspot') so the same moment can read differently for a
 * PPPoE subscriber vs a hotspot guest.
 *
 * Bodies use {placeholder} tokens — the sender passes already-formatted values
 * (e.g. receipt = "Receipt: ABC. " or ""), so substitution stays a dumb replace.
 */
import { query } from '../../db/pool.js';

export type Audience = 'hotspot' | 'pppoe';

export interface TemplateDef {
  event_key: string;
  audience: Audience;
  label: string;
  description: string;
  placeholders: string[];
  default_body: string;
  default_enabled: boolean;
}

export const CATALOG: TemplateDef[] = [
  {
    event_key: 'welcome', audience: 'pppoe',
    label: 'Welcome', description: 'Sent once when a PPPoE service is created — login + portal link.',
    placeholders: ['brand', 'first_name', 'username', 'password', 'portal_url'],
    default_body: '{brand}: Welcome {first_name}! Your internet login — user: {username} pass: {password}. Manage your plan: {portal_url}',
    default_enabled: true,
  },
  {
    event_key: 'wallet_topup', audience: 'pppoe',
    label: 'Wallet top-up', description: 'Wallet credited from M-Pesa.',
    placeholders: ['brand', 'amount', 'balance', 'receipt'],
    default_body: '{brand}: Wallet topped up KES {amount}.{receipt} New balance: KES {balance}.',
    default_enabled: true,
  },
  {
    event_key: 'renewed', audience: 'pppoe',
    label: 'Auto-renewed', description: 'Service auto-renewed from wallet balance.',
    placeholders: ['brand', 'service', 'amount', 'expiry', 'balance'],
    default_body: '{brand}: {service} auto-renewed (KES {amount}). Active until {expiry}. Wallet: KES {balance}.',
    default_enabled: true,
  },
  {
    event_key: 'low_balance', audience: 'pppoe',
    label: 'Low wallet balance', description: 'Wallet too low to auto-renew before expiry.',
    placeholders: ['brand', 'service', 'price', 'days', 'balance', 'shortfall', 'portal_url'],
    default_body: '{brand}: Auto-renew for {service} needs KES {price} in {days}d. Wallet: KES {balance} (short {shortfall}). Top up: {portal_url}',
    default_enabled: true,
  },
  {
    event_key: 'plan_changed', audience: 'pppoe',
    label: 'Plan changed', description: 'Admin changed the customer\'s plan.',
    placeholders: ['brand', 'plan', 'rate', 'portal_url'],
    default_body: '{brand}: Plan changed to {plan}{rate}. Manage: {portal_url}',
    default_enabled: true,
  },
  {
    event_key: 'suspended', audience: 'pppoe',
    label: 'Service suspended', description: 'Service was suspended.',
    placeholders: ['brand', 'service'],
    default_body: '{brand}: {service} has been suspended. Contact support if unexpected.',
    default_enabled: true,
  },
  {
    event_key: 'restored', audience: 'pppoe',
    label: 'Service restored', description: 'Service is active again.',
    placeholders: ['brand', 'service', 'username', 'portal_url'],
    default_body: '{brand}: {service} is active again — enjoy. Manage: {portal_url}{username}',
    default_enabled: true,
  },
  {
    event_key: 'hotspot_active', audience: 'hotspot',
    label: 'WiFi activated', description: 'Sent to a hotspot customer when their package activates after payment. OFF by default (one SMS per purchase has a cost).',
    placeholders: ['brand', 'package', 'expiry', 'amount'],
    default_body: '{brand}: Your {package} WiFi is now active until {expiry}. Enjoy!',
    default_enabled: false,
  },
];

function def(eventKey: string, audience: Audience): TemplateDef | undefined {
  return CATALOG.find((t) => t.event_key === eventKey && t.audience === audience);
}

async function overrides(): Promise<Map<string, { body: string; enabled: boolean }>> {
  const r = await query<{ event_key: string; audience: string; body: string; enabled: boolean }>(
    `SELECT event_key, audience, body, enabled FROM message_templates`
  );
  return new Map(r.rows.map((x) => [`${x.event_key}:${x.audience}`, { body: x.body, enabled: x.enabled }]));
}

export interface EffectiveTemplate extends TemplateDef {
  body: string;
  enabled: boolean;
  is_custom: boolean;
}

/** Catalog merged with overrides — what the dashboard edits. */
export async function listTemplates(): Promise<EffectiveTemplate[]> {
  const ov = await overrides();
  return CATALOG.map((t) => {
    const o = ov.get(`${t.event_key}:${t.audience}`);
    return {
      ...t,
      body: o?.body ?? t.default_body,
      enabled: o?.enabled ?? t.default_enabled,
      is_custom: !!o,
    };
  });
}

export async function setTemplate(eventKey: string, audience: Audience, input: { body?: string; enabled?: boolean }, by?: string): Promise<void> {
  const d = def(eventKey, audience);
  if (!d) throw new Error('unknown template');
  // Start from the current effective values so a partial edit keeps the rest.
  const ov = (await overrides()).get(`${eventKey}:${audience}`);
  const body = input.body ?? ov?.body ?? d.default_body;
  const enabled = input.enabled ?? ov?.enabled ?? d.default_enabled;
  await query(
    `INSERT INTO message_templates (event_key, audience, body, enabled, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_key, audience) DO UPDATE SET
       body = EXCLUDED.body, enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [eventKey, audience, body, enabled, by ?? 'admin']
  );
}

/** Drop the override → back to the in-code default. */
export async function resetTemplate(eventKey: string, audience: Audience): Promise<void> {
  await query(`DELETE FROM message_templates WHERE event_key=$1 AND audience=$2`, [eventKey, audience]);
}

/**
 * The text to send for an event, or null if the template is disabled. Used by
 * every customer-notification sender — substitutes {tokens} from `vars`.
 */
export async function render(eventKey: string, audience: Audience, vars: Record<string, string | number>): Promise<string | null> {
  const d = def(eventKey, audience);
  const o = (await overrides()).get(`${eventKey}:${audience}`);
  const body = o?.body ?? d?.default_body ?? '';
  const enabled = o?.enabled ?? d?.default_enabled ?? true;
  if (!enabled || !body) return null;
  return body.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
