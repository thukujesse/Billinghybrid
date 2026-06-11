/**
 * Advertisement routes. Admin CRUD (admin/staff) + public portal endpoints
 * (list active ads for a placement, record impression/click). Backed by
 * domains/ads/service.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as ads from '../../domains/ads/service.js';

const adBody = z.object({
  title: z.string().min(1),
  media_type: z.enum(['image', 'video']).optional(),
  media_url: z.string().min(1),
  link_url: z.string().optional(),
  placement: z.enum(['portal_banner', 'post_payment', 'dashboard']).optional(),
  target_router_id: z.string().uuid().nullable().optional(),
  weight: z.number().int().min(0).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export function registerAdsRoutes(api: Router): void {
  // ---- Admin ----
  api.get('/admin/ads', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    res.json(await ads.listAds());
  }));
  api.post('/admin/ads', requireAuth('admin', 'staff'), ah(async (req, res) => {
    res.status(201).json(await ads.createAd(parse(adBody, req.body)));
  }));
  api.patch('/admin/ads/:id', requireAuth('admin', 'staff'), ah(async (req, res) => {
    res.json(await ads.updateAd(req.params.id, parse(adBody.partial(), req.body)));
  }));
  api.delete('/admin/ads/:id', requireAuth('admin'), ah(async (req, res) => {
    await ads.deleteAd(req.params.id);
    res.status(204).end();
  }));

  // ---- Public (captive portal) ----
  api.get('/hotspot/ads', ah(async (req, res) => {
    const placement = (typeof req.query.placement === 'string' ? req.query.placement : 'portal_banner') as
      'portal_banner' | 'post_payment' | 'dashboard';
    const router = typeof req.query.router === 'string' && req.query.router ? req.query.router : undefined;
    res.json(await ads.listActiveAds(placement, router));
  }));
  api.post('/hotspot/ads/:id/impression', ah(async (req, res) => {
    try { await ads.recordImpression(req.params.id); } catch { /* never block the portal */ }
    res.status(204).end();
  }));
  api.post('/hotspot/ads/:id/click', ah(async (req, res) => {
    try { await ads.recordClick(req.params.id); } catch { /* never block the portal */ }
    res.status(204).end();
  }));
}
