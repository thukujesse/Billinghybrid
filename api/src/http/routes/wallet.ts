/**
 * Customer wallet routes — portal (self-serve) and admin (operator).
 * Wallet primitives live in domains/customers/wallet.ts; these routes
 * are the HTTP-facing wrappers with appropriate auth + zod validation.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as customerWallet from '../../domains/customers/wallet.js';
import * as portal from '../../domains/portal/service.js';

export function registerWalletRoutes(api: Router): void {
  // ---------------- Portal (customer-scoped) ----------------
  // Every route uses req.user!.sub as the customer id — no cross-customer
  // reads/writes are possible since the JWT carries the identity.
  api.get('/portal/wallet/txns', requireAuth('customer'), ah(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json(await portal.listWalletTxns(req.user!.sub, limit));
  }));
  api.post('/portal/wallet/topup', requireAuth('customer'), ah(async (req, res) => {
    const body = parse(z.object({
      amount_kes: z.number().int().min(10).max(70000),
      phone: z.string().min(7),
    }), req.body);
    res.json(await customerWallet.initWalletTopup({
      customerId: req.user!.sub,
      amountKes: body.amount_kes,
      phone: body.phone,
    }));
  }));
  api.post('/portal/wallet/renew', requireAuth('customer'), ah(async (req, res) => {
    const body = parse(z.object({ service_id: z.string().uuid() }), req.body);
    res.json(await customerWallet.renewServiceFromWallet({
      customerId: req.user!.sub,
      serviceId: body.service_id,
      actor: req.user!.sub,
    }));
  }));
  api.post('/portal/services/:id/auto-renew', requireAuth('customer'), ah(async (req, res) => {
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    await customerWallet.setAutoRenew(req.params.id, req.user!.sub, body.enabled);
    res.json({ ok: true });
  }));

  // ---------------- Admin ----------------
  api.get('/admin/customers/:id/wallet', requireAuth('admin', 'staff'), ah(async (req, res) => {
    const [balance, txns] = await Promise.all([
      customerWallet.getWallet(req.params.id),
      customerWallet.listTxns(req.params.id, 100),
    ]);
    res.json({ balance, txns });
  }));
  api.post('/admin/customers/:id/wallet/adjust', requireAuth('admin'), ah(async (req, res) => {
    const body = parse(z.object({
      amount_cents: z.number().int(),  // positive credit, negative debit
      kind: z.enum(['adjustment', 'refund']),
      notes: z.string().max(500).optional(),
      reference: z.string().max(120).optional(),
    }), req.body);
    const actorLabel = (req.user as any)?.username
      ? String((req.user as any).username)
      : String(req.user?.sub ?? 'admin');
    res.json(await customerWallet.applyTxn({
      customerId: req.params.id,
      amountCents: body.amount_cents,
      kind: body.kind,
      notes: body.notes,
      reference: body.reference,
      actor: actorLabel,
    }));
  }));
}
