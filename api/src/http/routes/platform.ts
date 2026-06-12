/**
 * Platform operator console (M3): HubNet's view over ALL ISP tenants + the
 * platform billing it raises against them. Strictly gated — only an admin on the
 * PLATFORM tenant (config.control.platformTenant, default 'default') may reach
 * these. A tenant admin hitting this on their own subdomain is 403'd, so the
 * control-DB registry never leaks across tenants.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { currentTenantId } from '../../db/pool.js';
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';
import * as tenants from '../../domains/tenants/service.js';
import * as billing from '../../domains/platform/billing.js';

/** Block anyone whose request didn't resolve to the platform tenant. */
function platformOnly(_req: Request, _res: Response, next: NextFunction): void {
  if (currentTenantId() !== config.control.platformTenant) {
    throw new AppError(403, 'forbidden', 'platform console is restricted to the platform operator');
  }
  next();
}

const gate = [requireAuth('admin'), platformOnly];

function currentPeriod(): string {
  // 'YYYY-MM' for now. Date is fine in app runtime (only Workflow scripts ban it).
  return new Date().toISOString().slice(0, 7);
}

export function registerPlatformRoutes(api: Router): void {
  // All tenants with their live monthly accrual + a couple of headline stats.
  api.get('/platform/tenants', ...gate, ah(async (_req, res) => {
    const all = await tenants.listTenants();
    const rows = await Promise.all(all.map(async (t) => {
      const accrual = await billing.accrue(t);
      return {
        id: t.id, slug: t.slug, name: t.name, status: t.status,
        isolated: !!t.db_conn_string,
        contact_phone: t.contact_phone ?? null,
        contact_email: t.contact_email ?? null,
        created_at: t.created_at,
        accrual,
      };
    }));
    res.json(rows);
  }));

  // Roll-up across the whole platform for the headline cards.
  api.get('/platform/summary', ...gate, ah(async (_req, res) => {
    const all = await tenants.listTenants();
    const accruals = await Promise.all(all.map((t) => billing.accrue(t)));
    const sum = (f: (a: billing.Accrual) => number) => accruals.reduce((n, a) => n + f(a), 0);
    res.json({
      tenants: all.length,
      active: all.filter((t) => t.status === 'active').length,
      suspended: all.filter((t) => t.status === 'suspended').length,
      period: currentPeriod(),
      fixed_active: sum((a) => a.fixed_active),
      fixed_charge_cents: sum((a) => a.fixed_charge_cents),
      hotspot_revenue_cents: sum((a) => a.hotspot_revenue_cents),
      hotspot_charge_cents: sum((a) => a.hotspot_charge_cents),
      total_cents: sum((a) => a.total_cents),
      currency: config.control.billing.currency,
      rates: {
        fixed_per_sub_cents: config.control.billing.fixedPerSubCents,
        hotspot_share_pct: config.control.billing.hotspotSharePct,
      },
    });
  }));

  // Lifecycle: suspend / resume a tenant.
  api.post('/platform/tenants/:id/suspend', ...gate, ah(async (req, res) => {
    await tenants.setTenantStatus(req.params.id, 'suspended');
    res.json({ ok: true, status: 'suspended' });
  }));
  api.post('/platform/tenants/:id/resume', ...gate, ah(async (req, res) => {
    await tenants.setTenantStatus(req.params.id, 'active');
    res.json({ ok: true, status: 'active' });
  }));

  // Invoices for one tenant.
  api.get('/platform/tenants/:id/invoices', ...gate, ah(async (req, res) => {
    res.json(await billing.listInvoices(req.params.id));
  }));

  // Snapshot the tenant's charge for a period (default current month).
  api.post('/platform/tenants/:id/invoices', ...gate, ah(async (req, res) => {
    const body = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.body ?? {});
    const t = await tenants.getTenantById(req.params.id);
    if (!t) throw new AppError(404, 'not_found', 'tenant not found');
    await billing.generateInvoice(t, body.period ?? currentPeriod());
    res.status(201).json({ ok: true });
  }));

  // Mark an invoice paid / void.
  api.post('/platform/invoices/:id/status', ...gate, ah(async (req, res) => {
    const body = parse(z.object({ status: z.enum(['issued', 'paid', 'void']) }), req.body);
    await billing.setInvoiceStatus(req.params.id, body.status);
    res.json({ ok: true });
  }));
}
