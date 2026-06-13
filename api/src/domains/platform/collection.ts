import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import { stkPush, parseCallback } from '../payments/daraja.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getTenantById, setTenantStatus } from '../tenants/service.js';
import { generateInvoice, setInvoiceStatus } from './billing.js';

// ---------------------------------------------------------------------------
// Platform-fee collection: HubNet STK-pushes an ISP's contact phone for their
// monthly platform invoice (via the PLATFORM tenant's own M-Pesa). On success
// the invoice is marked paid and a suspended tenant is auto-resumed. All state
// lives in the CONTROL DB (default pool).
// ---------------------------------------------------------------------------

export interface CollectResult { checkoutRequestId: string; amountKes: number; phone: string }

/** Ensure an invoice exists for `period`, then STK-push the tenant to collect it. */
export async function collect(tenantId: string, period: string): Promise<CollectResult> {
  const t = await getTenantById(tenantId);
  if (!t) throw notFound('tenant');
  if (!t.contact_phone) throw badRequest('tenant has no contact phone on file — add one before collecting');

  await generateInvoice(t, period); // snapshot/refresh the period's charge
  const inv = await pool.query<{ id: string; total_cents: number }>(
    `SELECT id, total_cents FROM tenant_invoice WHERE tenant_id=$1 AND period=$2`, [tenantId, period]
  );
  const invoice = inv.rows[0];
  if (!invoice || invoice.total_cents <= 0) throw badRequest('nothing to collect for this period');

  const amountKes = Math.round(invoice.total_cents / 100);
  const r = await stkPush({
    phone: t.contact_phone,
    amountKes,
    accountReference: `PLAT-${t.slug}`,
    description: 'Platform fee',
    callbackUrl: `${config.publicApiUrl}/api/platform/mpesa/callback`,
  });
  await pool.query(
    `INSERT INTO platform_collection
       (tenant_id, invoice_id, period, checkout_request_id, amount_cents, phone, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [tenantId, invoice.id, period, r.checkoutRequestId, invoice.total_cents, t.contact_phone]
  );
  return { checkoutRequestId: r.checkoutRequestId, amountKes, phone: t.contact_phone };
}

/** Daraja STK callback for a platform collection — mark paid + auto-resume. */
export async function handlePlatformCallback(body: any): Promise<void> {
  const cb = parseCallback(body);
  if (!cb) return;
  const r = await pool.query<{ id: string; tenant_id: string; invoice_id: string | null }>(
    `SELECT id, tenant_id, invoice_id FROM platform_collection WHERE checkout_request_id=$1`,
    [cb.checkoutRequestId]
  );
  const col = r.rows[0];
  if (!col) { console.warn(`[platform-collect] unknown checkout ${cb.checkoutRequestId}`); return; }

  if (cb.success) {
    await pool.query(
      `UPDATE platform_collection SET status='success', mpesa_receipt=$2, updated_at=now() WHERE id=$1`,
      [col.id, cb.receipt ?? null]
    );
    if (col.invoice_id) await setInvoiceStatus(col.invoice_id, 'paid');
    const t = await getTenantById(col.tenant_id);
    if (t && t.status === 'suspended') {
      await setTenantStatus(t.id, 'active');
      console.log(`[platform-collect] tenant ${t.slug} paid + auto-resumed (receipt ${cb.receipt})`);
    } else {
      console.log(`[platform-collect] tenant ${col.tenant_id} paid (receipt ${cb.receipt})`);
    }
  } else {
    await pool.query(`UPDATE platform_collection SET status='failed', updated_at=now() WHERE id=$1`, [col.id]);
  }
}
