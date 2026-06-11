/**
 * Customer-message template routes (admin). Backed by
 * domains/messageTemplates/service.ts. Live preview is done client-side, so the
 * API only needs list / set / reset.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as templates from '../../domains/messageTemplates/service.js';

export function registerMessageTemplateRoutes(api: Router): void {
  api.get('/admin/message-templates', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    res.json(await templates.listTemplates());
  }));

  api.put('/admin/message-templates/:event/:audience', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const audience = parse(z.enum(['hotspot', 'pppoe']), req.params.audience);
    const body = parse(z.object({
      body: z.string().min(1).max(800).optional(),
      enabled: z.boolean().optional(),
    }), req.body);
    const by = (req.user as { username?: string } | undefined)?.username;
    await templates.setTemplate(req.params.event, audience, body, by);
    res.json(await templates.listTemplates());
  }));

  api.post('/admin/message-templates/:event/:audience/reset', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const audience = parse(z.enum(['hotspot', 'pppoe']), req.params.audience);
    await templates.resetTemplate(req.params.event, audience);
    res.json(await templates.listTemplates());
  }));
}
