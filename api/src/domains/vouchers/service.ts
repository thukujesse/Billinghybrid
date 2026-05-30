import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { voucherCode } from '../../lib/codes.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { getPlan } from '../plans/service.js';
import { getOrCreateWallet, debit, credit } from '../wallet/service.js';
import { activateForPlan } from '../subscriptions/service.js';
import { provisioning } from '../provisioning/service.js';
import { emit } from '../events/bus.js';

export interface Voucher {
  id: string;
  code: string;
  batch_id: string | null;
  plan_id: string;
  status: 'unused' | 'used' | 'expired' | 'disabled';
  value_cents: number;
  used_by: string | null;
  used_at: string | null;
  expires_at: string | null;
}

export interface VoucherBatch {
  id: string;
  reseller_id: string | null;
  plan_id: string;
  quantity: number;
  prefix: string;
  cost_cents: number;
  created_at: string;
}

/**
 * Generate a batch of vouchers for a plan (Data Flow 04). If a reseller is
 * given, the batch cost (quantity x plan price) is debited from the reseller's
 * wallet in the same transaction — they cannot oversell their balance.
 */
export async function generateBatch(input: {
  planId: string;
  quantity: number;
  prefix?: string;
  resellerId?: string;
  createdBy?: string;
}): Promise<{ batch: VoucherBatch; vouchers: Voucher[] }> {
  if (input.quantity < 1 || input.quantity > 5000) {
    throw badRequest('quantity must be between 1 and 5000');
  }
  const plan = await getPlan(input.planId);
  const cost = plan.price_cents * input.quantity;

  return withTransaction(async (c) => {
    if (input.resellerId) {
      const wallet = await getOrCreateWallet('reseller', input.resellerId, c);
      // Throws payment_required (402) if the reseller can't cover the batch.
      await debit(wallet.id, cost, `Voucher batch x${input.quantity} (${plan.name})`, { type: 'voucher_batch' }, c);
    }

    const batchRow = await c.query<VoucherBatch>(
      `INSERT INTO voucher_batches (reseller_id, plan_id, quantity, prefix, cost_cents, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.resellerId ?? null, input.planId, input.quantity, input.prefix ?? '', cost, input.createdBy ?? 'admin']
    );
    const batch = batchRow.rows[0];

    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + Math.max(plan.validity_days * 6, 180));

    const vouchers: Voucher[] = [];
    for (let i = 0; i < input.quantity; i++) {
      // Retry on the (extremely rare) code collision.
      let inserted: Voucher | undefined;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        try {
          const v = await c.query<Voucher>(
            `INSERT INTO vouchers (code, batch_id, plan_id, value_cents, expires_at)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [voucherCode(input.prefix ?? ''), batch.id, input.planId, plan.price_cents, expires.toISOString()]
          );
          inserted = v.rows[0];
        } catch (err: any) {
          if (err?.code !== '23505') throw err; // not a unique violation
        }
      }
      if (!inserted) throw conflict('could not generate unique voucher code');
      vouchers.push(inserted);
    }

    await emit('voucher.batch.created', {
      batchId: batch.id,
      quantity: input.quantity,
      resellerId: input.resellerId ?? null,
    });
    return { batch, vouchers };
  });
}

/**
 * Redeem a voucher for a subscriber (Data Flow 01). Marks the voucher used,
 * activates/extends the plan subscription, provisions network access, and —
 * if the voucher came from a reseller batch — records the reseller commission.
 */
export async function redeem(code: string, subscriberId: string): Promise<{ voucher: Voucher; subscriptionId: string }> {
  return withTransaction(async (c) => {
    const r = await c.query<Voucher>(`SELECT * FROM vouchers WHERE code = $1 FOR UPDATE`, [code.trim().toUpperCase()]);
    const voucher = r.rows[0];
    if (!voucher) throw notFound('voucher');
    if (voucher.status !== 'unused') throw conflict(`voucher is ${voucher.status}`);
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      await c.query(`UPDATE vouchers SET status='expired' WHERE id=$1`, [voucher.id]);
      throw conflict('voucher has expired');
    }

    await c.query(
      `UPDATE vouchers SET status='used', used_by=$2, used_at=now() WHERE id=$1`,
      [voucher.id, subscriberId]
    );

    const subscription = await activateForPlan(subscriberId, voucher.plan_id, c);

    // Reseller commission on redemption.
    const batch = await c.query<VoucherBatch>('SELECT * FROM voucher_batches WHERE id = $1', [voucher.batch_id]);
    if (batch.rows[0]?.reseller_id) {
      const reseller = await c.query('SELECT commission_bps FROM resellers WHERE id = $1', [batch.rows[0].reseller_id]);
      const bps = reseller.rows[0]?.commission_bps ?? 0;
      if (bps > 0) {
        const commission = Math.round((voucher.value_cents * bps) / 10_000);
        if (commission > 0) {
          const wallet = await getOrCreateWallet('reseller', batch.rows[0].reseller_id, c);
          await credit(wallet.id, commission, `Commission on ${voucher.code}`, { type: 'commission', id: voucher.id }, c);
        }
      }
    }

    await provisioning.activate(subscriberId, { via: 'voucher', code: voucher.code });
    await emit('voucher.redeemed', { voucherId: voucher.id, subscriberId, planId: voucher.plan_id });
    return { voucher: { ...voucher, status: 'used' }, subscriptionId: subscription.id };
  });
}

export async function listVouchers(filter: { batchId?: string; status?: string } = {}): Promise<Voucher[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.batchId) { params.push(filter.batchId); clauses.push(`batch_id = $${params.length}`); }
  if (filter.status) { params.push(filter.status); clauses.push(`status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await query<Voucher>(`SELECT * FROM vouchers ${where} ORDER BY created_at DESC LIMIT 500`, params);
  return r.rows;
}

export async function listBatches(): Promise<VoucherBatch[]> {
  const r = await query<VoucherBatch>('SELECT * FROM voucher_batches ORDER BY created_at DESC');
  return r.rows;
}
