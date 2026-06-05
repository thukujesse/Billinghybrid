/**
 * Captive-portal diagnostics — admin trace UI backend.
 *
 * Three endpoints:
 *   POST /portal/events             — public beacon (portal-load + lookup-miss
 *                                       fired from the captive page)
 *   GET  /admin/diagnostics/trace   — admin chronological trace by mac/phone
 *   GET  /admin/diagnostics/summary — admin top-of-page rollup (last 24h)
 *
 * The public POST endpoint accepts ONLY a fixed set of event types
 * (portal_load, lookup_miss) so the public can't pollute the operator log
 * with arbitrary types like 'stk_callback'. Server-side emissions for the
 * paid/voucher/rebind flows happen inside the service modules with full
 * context — those event types are off-limits to the beacon.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as events from '../../domains/portal/events.js';

const PUBLIC_EVENT_TYPES = ['portal_load', 'lookup_miss'] as const;
type PublicEventType = (typeof PUBLIC_EVENT_TYPES)[number];

const beaconLimit = rateLimit({ name: 'portal_beacon', windowMs: 60_000, max: 30 });

export function registerDiagnosticsRoutes(api: Router): void {
  // Public beacon — captive portal fires this on mount + on each tier of
  // auto-grant that misses. Body schema is intentionally permissive (detail
  // is free-form jsonb) but `type` is restricted to PUBLIC_EVENT_TYPES.
  api.post('/portal/events', beaconLimit, ah(async (req, res) => {
    const body = parse(z.object({
      type: z.enum(PUBLIC_EVENT_TYPES as unknown as [PublicEventType, ...PublicEventType[]]),
      mac: z.string().max(64).optional(),
      phone: z.string().max(32).optional(),
      tenant: z.string().max(128).optional(),
      reason: z.string().max(128).optional(),
      detail: z.record(z.string(), z.unknown()).optional(),
      success: z.boolean().optional(),
    }), req.body);
    await events.emit({
      type: body.type,
      mac: body.mac ?? null,
      phone: body.phone ?? null,
      tenant: body.tenant ?? null,
      success: body.success ?? null,
      reason: body.reason ?? null,
      detail: body.detail ?? {},
      sourceIp: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json({ ok: true });
  }));

  // Admin: chronological trace by MAC OR phone. Pass exactly one. Empty
  // results array means "no events for this identifier in our window" —
  // not an error.
  api.get('/admin/diagnostics/trace', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const mac = typeof req.query.mac === 'string' && req.query.mac.trim() ? req.query.mac : null;
    const phone = typeof req.query.phone === 'string' && req.query.phone.trim() ? req.query.phone : null;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 1000) : 200;
    if (!mac && !phone) {
      return res.status(400).json({ error: 'pass mac or phone' });
    }
    if (mac && phone) {
      return res.status(400).json({ error: 'pass exactly one of mac or phone' });
    }
    const rows = mac
      ? await events.traceForMac(mac, limit)
      : await events.traceForPhone(phone!, limit);
    res.json({ rows });
  }));

  // Admin: rollup card data — total events, success rate, STK success rate,
  // unique macs/phones in the chosen window.
  api.get('/admin/diagnostics/summary', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const hours = req.query.hours ? Math.min(Number(req.query.hours), 168) : 24;
    res.json(await events.recentSummary(hours));
  }));

  // Admin: most recent failed portal events — drives the dashboard
  // "needs attention" panel. Each row clicks through to /diagnostics
  // with the right ?mac= or ?phone= already filled in.
  api.get('/admin/diagnostics/recent-failures', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const hours = req.query.hours ? Math.min(Number(req.query.hours), 168) : 24;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 50) : 5;
    res.json(await events.recentFailures(hours, limit));
  }));
}
