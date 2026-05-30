import { query } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { emit } from '../events/bus.js';
import { provisioning } from '../provisioning/service.js';
import { getOrCreateWallet } from '../wallet/service.js';

export interface Subscriber {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  type: 'hotspot' | 'pppoe';
  status: 'pending' | 'active' | 'suspended' | 'inactive';
  kyc_status: string;
  pppoe_username: string | null;
  reseller_id: string | null;
  language: 'en' | 'sw';
  created_at: string;
}

export interface CreateSubscriberInput {
  full_name: string;
  phone: string;
  email?: string;
  type?: 'hotspot' | 'pppoe';
  reseller_id?: string;
  pppoe_username?: string;
  pppoe_password?: string;
  language?: 'en' | 'sw';
}

export async function listSubscribers(): Promise<Subscriber[]> {
  const r = await query<Subscriber>('SELECT * FROM subscribers ORDER BY created_at DESC');
  return r.rows;
}

export async function getSubscriber(id: string): Promise<Subscriber> {
  const r = await query<Subscriber>('SELECT * FROM subscribers WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('subscriber');
  return r.rows[0];
}

export async function createSubscriber(input: CreateSubscriberInput): Promise<Subscriber> {
  const r = await query<Subscriber>(
    `INSERT INTO subscribers
       (full_name, phone, email, type, reseller_id, pppoe_username, pppoe_password, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.full_name,
      input.phone,
      input.email ?? null,
      input.type ?? 'hotspot',
      input.reseller_id ?? null,
      input.pppoe_username ?? null,
      input.pppoe_password ?? null,
      input.language ?? 'en',
    ]
  );
  const sub = r.rows[0];
  // Every subscriber gets a wallet for prepaid balance / auto-renewal.
  await getOrCreateWallet('subscriber', sub.id);
  await emit('subscriber.created', { subscriberId: sub.id, phone: sub.phone });
  return sub;
}

/**
 * Suspend a subscriber (Data Flow 05). Updates status, emits the event, and
 * pushes the network action through Provisioning (Mikrotik block + RADIUS reject).
 */
export async function suspendSubscriber(id: string, reason = 'manual'): Promise<Subscriber> {
  const sub = await getSubscriber(id);
  const r = await query<Subscriber>(
    `UPDATE subscribers SET status = 'suspended' WHERE id = $1 RETURNING *`,
    [id]
  );
  await query(`UPDATE subscriptions SET status = 'suspended' WHERE subscriber_id = $1 AND status = 'active'`, [id]);
  await provisioning.suspend(id, { reason });
  await emit('subscriber.suspended', { subscriberId: id, reason });
  void sub;
  return r.rows[0];
}

/** Restore a suspended subscriber (Flow 05 in reverse). */
export async function restoreSubscriber(id: string): Promise<Subscriber> {
  await getSubscriber(id);
  const r = await query<Subscriber>(
    `UPDATE subscribers SET status = 'active' WHERE id = $1 RETURNING *`,
    [id]
  );
  await query(`UPDATE subscriptions SET status = 'active' WHERE subscriber_id = $1 AND status = 'suspended'`, [id]);
  await provisioning.restore(id);
  await emit('subscriber.restored', { subscriberId: id });
  return r.rows[0];
}

/** Set a subscriber's preferred language (drives notification copy). */
export async function setLanguage(id: string, language: 'en' | 'sw'): Promise<Subscriber> {
  const r = await query<Subscriber>(
    `UPDATE subscribers SET language = $2 WHERE id = $1 RETURNING *`,
    [id, language]
  );
  if (!r.rows[0]) throw notFound('subscriber');
  return r.rows[0];
}

/** Look up a subscriber's language (defaults to 'en'); never throws. */
export async function languageOf(id: string): Promise<'en' | 'sw'> {
  const r = await query<{ language: 'en' | 'sw' }>('SELECT language FROM subscribers WHERE id = $1', [id]);
  return r.rows[0]?.language ?? 'en';
}
