/**
 * Network monitoring routes — per-router live state, sessions, top
 * consumers, bandwidth history. Backed by domains/network/service.ts
 * and the metrics sampler worker.
 */
import { Router } from 'express';
import { ah } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as network from '../../domains/network/service.js';

export function registerNetworkRoutes(api: Router): void {
  api.get('/admin/network/routers', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    res.json(await network.routerStatus());
  }));
  api.get('/admin/network/sessions', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const routerId = typeof req.query.router_id === 'string' ? req.query.router_id : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await network.liveSessions(routerId, limit));
  }));
  api.get('/admin/network/top-consumers', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const windowMin = req.query.window_min ? Number(req.query.window_min) : 60;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(await network.topConsumers(windowMin, limit));
  }));
  api.get('/admin/network/routers/:id/history', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const hours = req.query.hours ? Math.min(Number(req.query.hours), 72) : 6;
    res.json(await network.routerHistory(req.params.id, hours));
  }));
}
