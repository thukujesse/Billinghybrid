/**
 * Advertisement routes. Admin CRUD (admin/staff) + public portal endpoints
 * (list active ads for a placement, record impression/click). Backed by
 * domains/ads/service.ts.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as ads from '../../domains/ads/service.js';
import * as storage from '../../domains/storage/service.js';
import { currentTenantId } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

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

  // Upload an image/video file (base64 data URL in JSON) to filesystem storage,
  // return a served URL. Used for videos (too big for a DB data URL) — images
  // can use either. Tenant-namespaced so multitenant keeps each ISP's media apart.
  api.post('/admin/ads/upload', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const { dataUrl } = parse(z.object({ dataUrl: z.string().min(1) }), req.body);
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
    if (!m) throw badRequest('expected a base64 data URL');
    const ext = MIME_EXT[m[1].toLowerCase()];
    if (!ext) throw badRequest('unsupported media type (use PNG/JPG/WebP/GIF or MP4/WebM/MOV)');
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length > 10_000_000) throw badRequest('file too large — keep ad media under ~9 MB');
    const name = `${crypto.randomUUID()}.${ext}`;
    await storage.put(`ads/${currentTenantId()}/${name}`, buffer);
    res.status(201).json({ url: `/api/hotspot/ads/media/${name}` });
  }));

  // Public: serve an uploaded ad file (the captive portal renders these).
  api.get('/hotspot/ads/media/:name', ah(async (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    try {
      const buf = await storage.get(`ads/${currentTenantId()}/${name}`);
      res.setHeader('Content-Type', EXT_MIME[ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch {
      res.status(404).end();
    }
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
