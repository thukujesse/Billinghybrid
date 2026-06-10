/**
 * Network Digital Twin routes (Phase 1) — the live map + structural CRUD.
 * Reads are admin/staff; writes are admin. Backed by domains/twin/service.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as twin from '../../domains/twin/service.js';

const coord = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export function registerTwinRoutes(api: Router): void {
  // The whole geolocated network for the map.
  api.get('/admin/network/twin/map', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    res.json(await twin.getMap());
  }));

  // Customers not yet pinned — drives the "place on map" panel.
  api.get('/admin/network/twin/unlocated-customers', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 1000) : 200;
    res.json(await twin.listUnlocatedCustomers(limit));
  }));

  // --- Sites ---
  api.post('/admin/network/twin/sites', requireAuth('admin'), ah(async (req, res) => {
    const body = parse(coord.extend({
      name: z.string().min(1),
      type: z.enum(['pop', 'tower', 'cabinet', 'datacenter', 'office', 'other']).optional(),
      address: z.string().optional(),
      notes: z.string().optional(),
    }), req.body);
    res.status(201).json(await twin.createSite(body));
  }));
  api.delete('/admin/network/twin/sites/:id', requireAuth('admin'), ah(async (req, res) => {
    await twin.deleteSite(req.params.id);
    res.status(204).end();
  }));

  // --- Devices (vendor-agnostic nodes) ---
  api.post('/admin/network/twin/devices', requireAuth('admin'), ah(async (req, res) => {
    const body = parse(coord.extend({
      name: z.string().min(1),
      device_kind: z.enum(['router', 'switch', 'olt', 'onu', 'fat', 'splitter',
                           'ap_sector', 'tower', 'backhaul', 'pole', 'cpe']),
      device_role: z.enum(['core', 'aggregation', 'distribution', 'cpe']).optional(),
      vendor: z.string().optional(),
      transport: z.string().optional(),
      mgmt_ip: z.string().optional(),
      site_id: z.string().uuid().optional(),
      parent_id: z.string().uuid().optional(),
      capacity: z.number().int().positive().optional(),
    }), req.body);
    res.status(201).json(await twin.createDevice(body));
  }));
  api.delete('/admin/network/twin/devices/:id', requireAuth('admin'), ah(async (req, res) => {
    await twin.deleteDevice(req.params.id);
    res.status(204).end();
  }));

  // --- Customer location ---
  api.put('/admin/network/twin/customers/:id/location', requireAuth('admin'), ah(async (req, res) => {
    const body = parse(coord.extend({
      accuracy_m: z.number().optional(),
      altitude_m: z.number().optional(),
      source: z.enum(['manual', 'install', 'survey', 'lead', 'geocode']).optional(),
    }), req.body);
    await twin.setCustomerLocation(req.params.id, body);
    res.status(204).end();
  }));
  api.delete('/admin/network/twin/customers/:id/location', requireAuth('admin'), ah(async (req, res) => {
    await twin.removeCustomerLocation(req.params.id);
    res.status(204).end();
  }));
}
