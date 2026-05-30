import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { paymentRequired, notFound } from '../../lib/errors.js';

export interface Wallet {
  id: string;
  owner_type: 'subscriber' | 'reseller';
  owner_id: string;
  balance_cents: number;
  currency: string;
}

type OwnerType = 'subscriber' | 'reseller';

/** Fetch the wallet for an owner, creating it on first use. */
export async function getOrCreateWallet(
  ownerType: OwnerType,
  ownerId: string,
  client?: PoolClient
): Promise<Wallet> {
  const run = (c?: PoolClient) =>
    query<Wallet>(
      `INSERT INTO wallets (owner_type, owner_id, currency)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_type, owner_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
       RETURNING *`,
      [ownerType, ownerId, config.currency],
      c
    ).then((r) => r.rows[0]);
  return client ? run(client) : run();
}

/**
 * Post a ledger entry and move the balance atomically. Locks the wallet row
 * (FOR UPDATE) so concurrent debits/credits can't race the balance.
 * Pass an existing client to enrol in a caller's transaction.
 */
async function post(
  walletId: string,
  direction: 'credit' | 'debit',
  amountCents: number,
  reason: string,
  ref: { type?: string; id?: string },
  client: PoolClient
): Promise<Wallet> {
  if (amountCents <= 0) throw new Error('amount must be positive');

  const locked = await client.query<Wallet>(
    'SELECT * FROM wallets WHERE id = $1 FOR UPDATE',
    [walletId]
  );
  const wallet = locked.rows[0];
  if (!wallet) throw notFound('wallet');

  const delta = direction === 'credit' ? amountCents : -amountCents;
  const balanceAfter = wallet.balance_cents + delta;
  if (balanceAfter < 0) {
    throw paymentRequired('Insufficient wallet balance');
  }

  await client.query(
    `INSERT INTO ledger_entries
       (wallet_id, direction, amount_cents, balance_after_cents, reason, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [walletId, direction, amountCents, balanceAfter, reason, ref.type ?? null, ref.id ?? null]
  );
  const updated = await client.query<Wallet>(
    'UPDATE wallets SET balance_cents = $1 WHERE id = $2 RETURNING *',
    [balanceAfter, walletId]
  );
  return updated.rows[0];
}

export function credit(
  walletId: string,
  amountCents: number,
  reason: string,
  ref: { type?: string; id?: string } = {},
  client?: PoolClient
): Promise<Wallet> {
  return client
    ? post(walletId, 'credit', amountCents, reason, ref, client)
    : withTransaction((c) => post(walletId, 'credit', amountCents, reason, ref, c));
}

export function debit(
  walletId: string,
  amountCents: number,
  reason: string,
  ref: { type?: string; id?: string } = {},
  client?: PoolClient
): Promise<Wallet> {
  return client
    ? post(walletId, 'debit', amountCents, reason, ref, client)
    : withTransaction((c) => post(walletId, 'debit', amountCents, reason, ref, c));
}

export async function getWallet(ownerType: OwnerType, ownerId: string): Promise<Wallet | null> {
  const r = await query<Wallet>(
    'SELECT * FROM wallets WHERE owner_type = $1 AND owner_id = $2',
    [ownerType, ownerId]
  );
  return r.rows[0] ?? null;
}

export async function listLedger(walletId: string, limit = 50) {
  const r = await query(
    `SELECT * FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [walletId, limit]
  );
  return r.rows;
}
