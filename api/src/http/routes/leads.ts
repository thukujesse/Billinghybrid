/**
 * Leads funnel routes (Network Twin Phase 2). Reads admin/staff; writes admin.
 * Backed by domains/leads/service.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as leads from '../../domains/leads/service.js';

export function registerLeadsRoutes(api: Router): void {
  api.get('/admin/leads', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const stage = typeof req.query.stage === 'string' ? req.query.stage : undefined;
    res.json(await leads.listLeads(stage));
  }));

  api.get('/admin/leads/stats', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    res.json(await leads.leadStats());
  }));

  api.post('/admin/leads', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const body = parse(z.object({
      name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().optional(),
      service_interest: z.string().optional(),
      source: z.string().optional(),
      landmark: z.string().optional(),
      notes: z.string().optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    }), req.body);
    const by = (req.user as { username?: string } | undefined)?.username;
    res.status(201).json(await leads.createLead(body, by));
  }));

  api.post('/admin/leads/:id/transition', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const body = parse(z.object({
      to: z.enum(['lead', 'survey', 'scheduled', 'installing', 'on_hold', 'lost']),
      note: z.string().optional(),
    }), req.body);
    const by = (req.user as { username?: string } | undefined)?.username;
    res.json(await leads.transitionLead(req.params.id, body.to, body.note, by));
  }));

  api.put('/admin/leads/:id/location', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const body = parse(z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }), req.body);
    await leads.setLeadLocation(req.params.id, body.latitude, body.longitude);
    res.status(204).end();
  }));

  api.post('/admin/leads/:id/convert', requireAuth('admin'), ah(async (req, res) => {
    const by = (req.user as { username?: string } | undefined)?.username;
    res.json(await leads.convertLead(req.params.id, by));
  }));

  api.delete('/admin/leads/:id', requireAuth('admin'), ah(async (req, res) => {
    await leads.deleteLead(req.params.id);
    res.status(204).end();
  }));
}
