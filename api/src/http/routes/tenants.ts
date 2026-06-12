/**
 * Control-plane routes (M2): tenant registry + self-serve "Register your ISP"
 * signup. The registry always lives in the control DB, so these handlers go
 * through domains/tenants/service.ts (which talks to the default pool directly).
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { config } from '../../config.js';
import { badRequest } from '../../lib/errors.js';
import * as tenants from '../../domains/tenants/service.js';
import { provisionTenant, normalizeSlug } from '../../domains/tenants/provision.js';

// Provisioning a tenant creates a database — expensive and abuse-prone. Cap it
// hard per IP.
const registerLimit = rateLimit({ name: 'tenant_register', windowMs: 600_000, max: 3 });
const slugCheckLimit = rateLimit({ name: 'tenant_slug', windowMs: 60_000, max: 30 });

export function registerTenantRoutes(api: Router): void {
  // Is self-serve signup available, and under what base domain? Drives the
  // public "Register your ISP" page.
  api.get('/tenants/signup-info', ah(async (_req, res) => {
    res.json({ selfServe: config.control.selfServe, baseDomain: config.control.baseDomain });
  }));

  // Caddy on-demand-TLS gate. Caddy calls GET ?domain=<sni> before issuing a
  // cert for an unknown host; we return 200 ONLY for hostnames that map to an
  // active tenant, so a cert is minted for real signups (and tenant custom
  // domains) but never for random probes — which protects the LE rate limit.
  api.get('/tenants/cert-check', ah(async (req, res) => {
    const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
    const t = domain ? await tenants.resolveTenantByHost(domain) : null;
    if (t && t.status === 'active') return res.status(200).send('ok');
    return res.status(404).send('unknown host');
  }));

  // Is a desired subdomain free? (Cheap pre-check for the signup form.)
  api.get('/tenants/slug-available', slugCheckLimit, ah(async (req, res) => {
    const raw = typeof req.query.slug === 'string' ? req.query.slug : '';
    let slug: string;
    try { slug = normalizeSlug(raw); }
    catch (e: any) { return res.json({ available: false, reason: e.message }); }
    const taken = await tenants.slugTaken(slug);
    res.json({ available: !taken, slug, ...(taken ? { reason: 'already taken' } : {}) });
  }));

  // Self-serve signup: provision a fully isolated tenant (DB + admin + domain).
  api.post('/tenants/register', registerLimit, ah(async (req, res) => {
    if (!config.control.selfServe) throw badRequest('self-serve signup is disabled — contact the platform operator');
    const body = parse(z.object({
      name: z.string().min(1).max(120),
      slug: z.string().min(3).max(32),
      adminUsername: z.string().min(3).max(40),
      adminPassword: z.string().min(6).max(200),
      contactPhone: z.string().max(30).optional(),
      contactEmail: z.string().email().max(120).optional(),
    }), req.body);
    const result = await provisionTenant(body);
    res.status(201).json(result);
  }));

  // Platform view of all tenants (admin only). Hides raw conn strings.
  api.get('/tenants', requireAuth('admin'), ah(async (_req, res) => {
    const all = await tenants.listTenants();
    res.json(all.map((t) => ({
      id: t.id, slug: t.slug, name: t.name, status: t.status,
      isolated: !!t.db_conn_string, contact_phone: t.contact_phone,
      contact_email: t.contact_email, created_at: t.created_at,
    })));
  }));
}
