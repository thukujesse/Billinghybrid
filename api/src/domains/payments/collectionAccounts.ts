import { query, currentTenantUuid } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  registerPaybill, unregisterPaybill, unregisterBankAccount,
} from '../platform/tenantPaybill.js';

/**
 * Collection accounts — an ISP's no-API payment destinations (paybill / till /
 * bank), each assignable per router. The destination is just a number the
 * customer pays directly; the shared callback/IPN registry (tenant_paybill,
 * control DB) routes each confirmation back to the tenant by that number, so we
 * keep the registry in sync whenever an account is created / changed / removed.
 *
 * Routing key by method:  paybill -> paybill   till -> till   bank -> account_no
 */

export type CollectionMethod = 'paybill' | 'till' | 'bank';

export interface CollectionAccount {
  id: string;
  label: string;
  method: CollectionMethod;
  paybill: string;
  till: string;
  account_no: string;
  account_name: string;
  is_default: boolean;
  provider: string;       // '' = manual (customer pays by hand); else bank STK provider (equity_jenga|kcb)
  provider_env: string;   // sandbox | live
  created_at: string;
  updated_at: string;
}

export interface CollectionAccountInput {
  label: string;
  method: CollectionMethod;
  paybill?: string;
  till?: string;
  account_no?: string;
  account_name?: string;
  is_default?: boolean;
  provider?: string;
  provider_env?: string;
}

/** The number the registry routes by + the kind it's registered under. */
function routingKey(a: { method: CollectionMethod; paybill: string; till: string; account_no: string }) {
  if (a.method === 'bank') return a.account_no.trim();
  if (a.method === 'till') return a.till.trim();
  return a.paybill.trim();
}

/** Claim the destination in the control-plane registry (rejects a number owned
 *  by another ISP). No-op when there's no tenant context (single-tenant dev). */
async function syncRegister(a: CollectionAccount): Promise<void> {
  const uuid = currentTenantUuid();
  if (!uuid) return;
  if (a.method === 'bank') await registerPaybill(a.paybill.trim(), uuid, 'bank', a.account_no.trim());
  else if (a.method === 'till') await registerPaybill(a.till.trim(), uuid, 'till');
  else await registerPaybill(a.paybill.trim(), uuid, 'paybill');
}

/** Drop a destination's registry claim (when the account is deleted/retargeted). */
async function syncUnregister(a: { method: CollectionMethod; paybill: string; till: string; account_no: string }): Promise<void> {
  const uuid = currentTenantUuid();
  if (!uuid) return;
  if (a.method === 'bank') await unregisterBankAccount(a.account_no.trim(), uuid);
  else if (a.method === 'till') await unregisterPaybill(a.till.trim(), uuid);
  else await unregisterPaybill(a.paybill.trim(), uuid);
}

function validate(input: CollectionAccountInput): void {
  if (!input.label?.trim()) throw badRequest('label is required');
  if (!['paybill', 'till', 'bank'].includes(input.method)) throw badRequest('invalid method');
  if (input.method === 'bank') {
    if (!input.paybill?.trim()) throw badRequest('bank paybill is required (e.g. Equity 247247)');
    if (!input.account_no?.trim()) throw badRequest('bank account number is required');
  } else if (input.method === 'till') {
    if (!input.till?.trim()) throw badRequest('till number is required');
  } else {
    if (!input.paybill?.trim()) throw badRequest('paybill number is required');
  }
}

export async function listCollectionAccounts(): Promise<CollectionAccount[]> {
  const r = await query<CollectionAccount>(
    `SELECT * FROM collection_account ORDER BY is_default DESC, created_at`
  );
  return r.rows;
}

export async function createCollectionAccount(input: CollectionAccountInput): Promise<CollectionAccount> {
  validate(input);
  // First account becomes the default automatically.
  const existing = await query<{ n: string }>(`SELECT count(*)::text AS n FROM collection_account`);
  const makeDefault = input.is_default || existing.rows[0].n === '0';
  if (makeDefault) await query(`UPDATE collection_account SET is_default = FALSE WHERE is_default`);
  // Only bank accounts can fire a bank STK provider; paybill/till stay manual.
  const provider = input.method === 'bank' ? (input.provider ?? '').trim() : '';
  const providerEnv = input.provider_env === 'live' ? 'live' : 'sandbox';
  const r = await query<CollectionAccount>(
    `INSERT INTO collection_account (label, method, paybill, till, account_no, account_name, is_default, provider, provider_env)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.label.trim(), input.method, (input.paybill ?? '').trim(), (input.till ?? '').trim(),
     (input.account_no ?? '').trim(), (input.account_name ?? '').trim(), makeDefault, provider, providerEnv]
  );
  const acct = r.rows[0];
  await syncRegister(acct); // may throw conflict if the number belongs to another ISP
  return acct;
}

export async function updateCollectionAccount(id: string, input: CollectionAccountInput): Promise<CollectionAccount> {
  validate(input);
  const prev = (await query<CollectionAccount>(`SELECT * FROM collection_account WHERE id = $1`, [id])).rows[0];
  if (!prev) throw notFound('collection account');
  if (input.is_default) await query(`UPDATE collection_account SET is_default = FALSE WHERE is_default AND id <> $1`, [id]);
  const provider = input.method === 'bank' ? (input.provider ?? '').trim() : '';
  const providerEnv = input.provider_env === 'live' ? 'live' : 'sandbox';
  const r = await query<CollectionAccount>(
    `UPDATE collection_account
        SET label=$2, method=$3, paybill=$4, till=$5, account_no=$6, account_name=$7,
            is_default = COALESCE($8, is_default), provider=$9, provider_env=$10, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, input.label.trim(), input.method, (input.paybill ?? '').trim(), (input.till ?? '').trim(),
     (input.account_no ?? '').trim(), (input.account_name ?? '').trim(),
     input.is_default === undefined ? null : input.is_default, provider, providerEnv]
  );
  const acct = r.rows[0];
  // If the routing destination changed, release the old claim before taking the new.
  if (routingKey(prev) !== routingKey(acct) || prev.method !== acct.method) {
    await syncUnregister(prev);
  }
  await syncRegister(acct);
  return acct;
}

export async function deleteCollectionAccount(id: string): Promise<void> {
  const prev = (await query<CollectionAccount>(`SELECT * FROM collection_account WHERE id = $1`, [id])).rows[0];
  if (!prev) return;
  await syncUnregister(prev);
  await query(`DELETE FROM collection_account WHERE id = $1`, [id]); // routers.collection_account_id -> NULL
}

export async function setDefaultCollectionAccount(id: string): Promise<CollectionAccount> {
  const acct = (await query<CollectionAccount>(`SELECT * FROM collection_account WHERE id = $1`, [id])).rows[0];
  if (!acct) throw notFound('collection account');
  await query(`UPDATE collection_account SET is_default = FALSE WHERE is_default`);
  const r = await query<CollectionAccount>(
    `UPDATE collection_account SET is_default = TRUE, updated_at = now() WHERE id = $1 RETURNING *`, [id]
  );
  return r.rows[0];
}

/**
 * Resolve the collection account a paying customer should use, given the router
 * they're connected to. Prefer the NAS address (precise), then the brand slug
 * (baked into the captive-portal template per router). Falls back to the tenant
 * default account. Returns null account when none configured -> caller uses the
 * legacy global M-Pesa settings.
 */
export async function resolveForRouter(
  opts: { nas?: string; slug?: string }
): Promise<{ account: CollectionAccount | null; routerId: string | null }> {
  let router: { id: string; collection_account_id: string | null } | undefined;
  const nas = (opts.nas ?? '').trim();
  const slug = (opts.slug ?? '').trim();
  if (nas) {
    router = (await query<{ id: string; collection_account_id: string | null }>(
      `SELECT id, collection_account_id FROM routers WHERE wg_tunnel_ip = $1 LIMIT 1`, [nas]
    )).rows[0];
  }
  if (!router && slug) {
    router = (await query<{ id: string; collection_account_id: string | null }>(
      `SELECT id, collection_account_id FROM routers WHERE brand_slug = $1 LIMIT 1`, [slug]
    )).rows[0];
  }
  let account: CollectionAccount | null = null;
  if (router?.collection_account_id) {
    account = (await query<CollectionAccount>(`SELECT * FROM collection_account WHERE id = $1`, [router.collection_account_id])).rows[0] ?? null;
  }
  if (!account) {
    account = (await query<CollectionAccount>(`SELECT * FROM collection_account WHERE is_default LIMIT 1`)).rows[0] ?? null;
  }
  return { account, routerId: router?.id ?? null };
}

/** Assign (or clear) a router's collection account. */
export async function setRouterCollectionAccount(routerId: string, accountId: string | null): Promise<void> {
  if (accountId) {
    const a = (await query(`SELECT 1 FROM collection_account WHERE id = $1`, [accountId])).rowCount;
    if (!a) throw notFound('collection account');
  }
  const r = await query(`UPDATE routers SET collection_account_id = $2 WHERE id = $1`, [routerId, accountId]);
  if (!r.rowCount) throw notFound('router');
}
