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
import * as smsBilling from '../../domains/platform/smsBilling.js';
import { impersonationToken } from '../../domains/auth/service.js';
import { normalizeSlug } from '../../domains/tenants/provision.js';

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
      const [accrual, sms_balance_cents] = await Promise.all([
        billing.accrue(t),
        smsBilling.getBalance(t.id),
      ]);
      return {
        id: t.id, slug: t.slug, name: t.name, status: t.status,
        isolated: !!t.db_conn_string,
        contact_phone: t.contact_phone ?? null,
        contact_email: t.contact_email ?? null,
        created_at: t.created_at,
        accrual,
        sms_balance_cents,
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

  // Impersonate: mint a short-lived admin token + the URL that logs the
  // operator into the tenant's own dashboard (token passed via ?imp=).
  api.post('/platform/tenants/:id/impersonate', ...gate, ah(async (req, res) => {
    const t = await tenants.getTenantById(req.params.id);
    if (!t) throw new AppError(404, 'not_found', 'tenant not found');
    const operator = (req.user as any)?.username ?? 'operator';
    const token = impersonationToken(t.slug, operator);
    const host = `${t.slug}.${config.control.baseDomain}`;
    res.json({ token, host, url: `https://${host}/login?imp=${encodeURIComponent(token)}` });
  }));

  // Change a tenant's subdomain (rename slug + swap host mapping; new host is
  // TLS-served on first visit).
  api.post('/platform/tenants/:id/subdomain', ...gate, ah(async (req, res) => {
    const body = parse(z.object({ slug: z.string().min(3).max(32) }), req.body);
    const t = await tenants.getTenantById(req.params.id);
    if (!t) throw new AppError(404, 'not_found', 'tenant not found');
    if (t.slug === 'default') throw new AppError(400, 'bad_request', 'cannot rename the platform tenant');
    const newSlug = normalizeSlug(body.slug);
    if (newSlug !== t.slug && (await tenants.slugTaken(newSlug))) {
      throw new AppError(409, 'conflict', `the subdomain "${newSlug}" is already taken`);
    }
    const { host } = await tenants.changeSubdomain(t, newSlug, config.control.baseDomain);
    res.json({ ok: true, slug: newSlug, host });
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

  // SMS prepaid balance + recent ledger for one tenant.
  api.get('/platform/tenants/:id/sms', ...gate, ah(async (req, res) => {
    const [balance_cents, ledger] = await Promise.all([
      smsBilling.getBalance(req.params.id),
      smsBilling.recentLedger(req.params.id, 20),
    ]);
    res.json({
      balance_cents, ledger, currency: config.control.billing.currency,
      cost_per_segment_cents: config.control.sms.costCentsPerSegment,
      segment_chars: config.control.sms.segmentChars,
    });
  }));

  // Top up a tenant's SMS balance (amount in KES).
  api.post('/platform/tenants/:id/sms/topup', ...gate, ah(async (req, res) => {
    const body = parse(z.object({ kes: z.number().positive().max(1_000_000) }), req.body);
    const t = await tenants.getTenantById(req.params.id);
    if (!t) throw new AppError(404, 'not_found', 'tenant not found');
    const balance = await smsBilling.credit(t.id, Math.round(body.kes * 100), 'topup');
    res.json({ ok: true, balance_cents: balance });
  }));

  // Mark an invoice paid / void.
  api.post('/platform/invoices/:id/status', ...gate, ah(async (req, res) => {
    const body = parse(z.object({ status: z.enum(['issued', 'paid', 'void']) }), req.body);
    await billing.setInvoiceStatus(req.params.id, body.status);
    res.json({ ok: true });
  }));
}
