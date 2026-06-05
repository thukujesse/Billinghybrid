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

  // Admin: end-to-end data-state probe for a MAC or phone. Surfaces:
  //   - whether the active_devices row exists for that MAC (and its source)
  //   - whether the hotspot_purchases row exists for that phone+MAC and its status
  //   - whether the portal_events table exists at all (catches migration-not-run cases)
  //
  // Designed so the operator can answer "is this customer's payment recorded
  // and the grant materialized?" in one HTTP call when diagnostics shows
  // nothing helpful. The trace timeline is great for chronology; this is the
  // current-state snapshot.
  api.get('/admin/diagnostics/probe', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const { query } = await import('../../db/pool.js');
    const mac = typeof req.query.mac === 'string' ? req.query.mac : null;
    const phone = typeof req.query.phone === 'string' ? req.query.phone : null;
    if (!mac && !phone) return res.status(400).json({ error: 'pass mac or phone' });

    // Normalize using the same helpers the rest of the system uses.
    const { normalizeMac } = await import('../../domains/hotspotDevices/service.js');
    const { normalizeMsisdn } = await import('../../domains/payments/daraja.js');
    const normMac = mac ? normalizeMac(mac) : null;
    const normPhone = phone ? safeNormalize(phone, normalizeMsisdn) : null;

    // Migration check — portal_events not existing is a critical operator signal.
    const tableCheck = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'portal_events') AS exists`
    );
    const portalEventsExists = tableCheck.rows[0]?.exists ?? false;

    const activeDevice = normMac
      ? (await query(
          `SELECT mac, expires_at, source, phone, purchase_id,
                  (expires_at > now()) AS live, last_seen
             FROM active_devices WHERE mac = $1`,
          [normMac]
        )).rows[0] ?? null
      : null;

    const recentPurchases = normPhone
      ? (await query(
          `SELECT id, checkout_request_id, status, mac_address, amount_kes,
                  validity_seconds, completed_at, failure_reason, receipt, created_at
             FROM hotspot_purchases
            WHERE phone = $1
            ORDER BY created_at DESC LIMIT 5`,
          [normPhone]
        )).rows
      : [];

    // Anything for this MAC in hotspot_purchases regardless of phone? Catches
    // cases where the MAC was captured but never flipped to status='success'.
    const purchasesByMac = normMac
      ? (await query(
          `SELECT id, checkout_request_id, status, phone, validity_seconds, completed_at, created_at
             FROM hotspot_purchases
            WHERE LOWER(mac_address) = $1
            ORDER BY created_at DESC LIMIT 5`,
          [normMac]
        )).rows
      : [];

    res.json({
      input: { mac, phone },
      normalized: { mac: normMac, phone: normPhone },
      portal_events_table_exists: portalEventsExists,
      active_device: activeDevice,
      recent_purchases_by_phone: recentPurchases,
      recent_purchases_by_mac: purchasesByMac,
      hint: !portalEventsExists
        ? 'portal_events table is MISSING — migration 037 did not run. Check the deploy logs for migration errors.'
        : !activeDevice && normMac
        ? 'no active_devices row for this MAC. Check recent_purchases_by_mac — if there are status=success purchases, the trigger from migration 021 may have failed.'
        : activeDevice && !activeDevice.live
        ? 'active_devices row exists but expired. Customer needs to repay.'
        : activeDevice
        ? 'active_devices row is live — MikroTik RADIUS auth should accept this MAC.'
        : 'pass mac to inspect device state.',
    });
  }));
}

function safeNormalize<T>(input: string, fn: (s: string) => T): T | null {
  try { return fn(input); } catch { return null; }
}
