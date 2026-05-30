import { query } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { getOrCreateWallet } from '../wallet/service.js';

export interface Reseller {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  commission_bps: number;
  status: 'active' | 'suspended';
  created_at: string;
}

export async function listResellers(): Promise<Reseller[]> {
  const r = await query<Reseller>('SELECT * FROM resellers ORDER BY created_at DESC');
  return r.rows;
}

export async function getReseller(id: string): Promise<Reseller> {
  const r = await query<Reseller>('SELECT * FROM resellers WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('reseller');
  return r.rows[0];
}

export async function createReseller(input: {
  name: string;
  phone?: string;
  email?: string;
  commission_bps?: number;
}): Promise<Reseller> {
  const r = await query<Reseller>(
    `INSERT INTO resellers (name, phone, email, commission_bps)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.name, input.phone ?? null, input.email ?? null, input.commission_bps ?? 1000]
  );
  const reseller = r.rows[0];
  await getOrCreateWallet('reseller', reseller.id);
  return reseller;
}
