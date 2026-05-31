import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from './helpers.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import * as auth from '../domains/auth/service.js';

// Auth endpoints are brute-force targets — limit by IP.
const loginLimit = rateLimit({ name: 'login', windowMs: 60_000, max: 10 });
const otpRequestLimit = rateLimit({ name: 'otp_req', windowMs: 60_000, max: 5 });
const otpVerifyLimit = rateLimit({ name: 'otp_vrf', windowMs: 60_000, max: 10 });

import * as plans from '../domains/plans/service.js';
import * as subscribers from '../domains/subscribers/service.js';
import * as subscriptions from '../domains/subscriptions/service.js';
import * as billing from '../domains/billing/service.js';
import * as payments from '../domains/payments/service.js';
import { parseCallback } from '../domains/payments/daraja.js';
import * as vouchers from '../domains/vouchers/service.js';
import * as resellers from '../domains/resellers/service.js';
import * as usage from '../domains/usage/service.js';
import * as wallet from '../domains/wallet/service.js';
import * as reports from '../domains/reports/service.js';
import { getInvoicePdf } from '../domains/billing/invoicePdf.js';
import * as routers from '../domains/routers/service.js';
import * as kyc from '../domains/kyc/service.js';
import * as purchases from '../domains/purchases/service.js';
import * as planchanges from '../domains/planchanges/service.js';
import * as credits from '../domains/credits/service.js';
import * as refunds from '../domains/refunds/service.js';
import { listPlugins } from '../plugins/index.js';
import { handleUpdate } from '../domains/telegram/bot.js';
import { config } from '../config.js';

export const api = Router();

// ------------------------------- Auth -------------------------------
// Staff/admin password login.
api.post('/auth/login', loginLimit, ah(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  res.json(await auth.loginPassword(body.username, body.password));
}));
// Create a staff user (admin only when auth is enabled).
api.post('/auth/users', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    username: z.string().min(3),
    password: z.string().min(6),
    role: z.enum(['admin', 'staff', 'reseller']).optional(),
    reseller_id: z.string().uuid().optional(),
  }), req.body);
  res.status(201).json(await auth.createUser(body));
}));
// Subscriber SMS OTP login.
api.post('/auth/otp/request', otpRequestLimit, ah(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(7) }), req.body);
  res.json(await auth.requestOtp(body.phone));
}));
api.post('/auth/otp/verify', otpVerifyLimit, ah(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(7), code: z.string().min(4) }), req.body);
  res.json(await auth.verifyOtp(body.phone, body.code));
}));
// Echo the caller's identity from their token.
api.get('/auth/me', requireAuth(), ah(async (req, res) => res.json(req.user)));

// --------------------------- Telegram bot ---------------------------
// Telegram posts updates here. The secret path token guards the endpoint;
// commands are further restricted to the chat-id allowlist inside handleUpdate.
api.post('/telegram/webhook/:secret', ah(async (req, res) => {
  if (!config.telegram.webhookSecret || req.params.secret !== config.telegram.webhookSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = await handleUpdate(req.body);
  res.json({ ok: true, handled: result.handled });
}));

// ----------------------------- Plugins ------------------------------
api.get('/plugins', ah(async (_req, res) => res.json(listPlugins())));

// ---------------------------- Dashboard -----------------------------
api.get('/dashboard', ah(async (_req, res) => res.json(await reports.dashboard())));
api.get('/reports/revenue', ah(async (_req, res) => res.json(await reports.revenueByMonth())));
api.get('/reports/top-plans', ah(async (_req, res) => res.json(await reports.topPlans())));
api.get('/reports/churn', ah(async (_req, res) => res.json(await reports.churnAndMrr())));
api.get('/reports/payments.csv', ah(async (_req, res) => {
  const csv = await reports.paymentsCsv();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
  res.send(csv);
}));

// ----------------------------- Plans --------------------------------
api.get('/plans', ah(async (req, res) => {
  res.json(await plans.listPlans(req.query.all === 'true'));
}));
api.post('/plans', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1),
    type: z.enum(['prepaid', 'postpaid', 'hotspot']),
    price_cents: z.number().int().nonnegative(),
    billing_cycle: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
    validity_days: z.number().int().positive().optional(),
    data_cap_mb: z.number().int().positive().nullable().optional(),
    speed_down_kbps: z.number().int().positive().nullable().optional(),
    speed_up_kbps: z.number().int().positive().nullable().optional(),
    fup_threshold_pct: z.number().int().min(1).max(100).optional(),
  }), req.body);
  res.status(201).json(await plans.createPlan(body));
}));
api.get('/plans/:id', ah(async (req, res) => res.json(await plans.getPlan(req.params.id))));

// --------------------------- Subscribers ----------------------------
api.get('/subscribers', ah(async (req, res) => {
  const phone = req.query.phone as string | undefined;
  if (phone) {
    const all = await subscribers.listSubscribers();
    return res.json(all.filter((s) => s.phone === phone));
  }
  res.json(await subscribers.listSubscribers());
}));
api.post('/subscribers', ah(async (req, res) => {
  const body = parse(z.object({
    full_name: z.string().min(1),
    phone: z.string().min(7),
    email: z.string().email().optional(),
    type: z.enum(['hotspot', 'pppoe']).optional(),
    reseller_id: z.string().uuid().optional(),
    pppoe_username: z.string().optional(),
    pppoe_password: z.string().optional(),
    language: z.enum(['en', 'sw']).optional(),
  }), req.body);
  res.status(201).json(await subscribers.createSubscriber(body));
}));
api.post('/subscribers/:id/language', ah(async (req, res) => {
  const body = parse(z.object({ language: z.enum(['en', 'sw']) }), req.body);
  res.json(await subscribers.setLanguage(req.params.id, body.language));
}));
api.get('/subscribers/:id', ah(async (req, res) => {
  const sub = await subscribers.getSubscriber(req.params.id);
  const subs = await subscriptions.listForSubscriber(sub.id);
  const w = await wallet.getWallet('subscriber', sub.id);
  res.json({ ...sub, subscriptions: subs, wallet: w });
}));
api.post('/subscribers/:id/suspend', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await subscribers.suspendSubscriber(req.params.id, req.body?.reason));
}));
api.post('/subscribers/:id/restore', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await subscribers.restoreSubscriber(req.params.id));
}));
api.get('/subscribers/:id/invoices', ah(async (req, res) => {
  res.json(await billing.listInvoices(req.params.id));
}));
api.get('/subscribers/:id/wallet', ah(async (req, res) => {
  const w = await wallet.getWallet('subscriber', req.params.id);
  if (!w) return res.json({ balance_cents: 0, entries: [] });
  res.json({ ...w, entries: await wallet.listLedger(w.id) });
}));

// -------------------------- Subscriptions ---------------------------
api.post('/subscribers/:id/subscribe', ah(async (req, res) => {
  const body = parse(z.object({ plan_id: z.string().uuid() }), req.body);
  res.status(201).json(await subscriptions.activateForPlan(req.params.id, body.plan_id));
}));

// Buy a plan from wallet (optionally gift it to another subscriber).
api.post('/subscribers/:id/buy-plan', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    recipient_id: z.string().uuid().optional(),
  }), req.body);
  res.json(await purchases.buyPlan({ buyerId: req.params.id, planId: body.plan_id, recipientId: body.recipient_id }));
}));

// Change plan mid-cycle with proration (upgrade/downgrade).
api.post('/subscribers/:id/change-plan', ah(async (req, res) => {
  const body = parse(z.object({ plan_id: z.string().uuid() }), req.body);
  res.json(await planchanges.changePlan({ subscriberId: req.params.id, newPlanId: body.plan_id }));
}));

// ----------------------------- Billing ------------------------------
api.get('/invoices', ah(async (_req, res) => res.json(await billing.listInvoices())));
api.get('/invoices/:id', ah(async (req, res) => res.json(await billing.getInvoice(req.params.id))));
api.get('/invoices/:id/pdf', ah(async (req, res) => {
  const { buffer, filename } = await getInvoicePdf(req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}));
api.post('/invoices', ah(async (req, res) => {
  const body = parse(z.object({
    subscriber_id: z.string().uuid(),
    subscription_id: z.string().uuid().optional(),
    lines: z.array(z.object({
      description: z.string().min(1),
      quantity: z.number().int().positive().optional(),
      unit_price_cents: z.number().int().nonnegative(),
    })).min(1),
  }), req.body);
  res.status(201).json(await billing.createInvoice(body.subscriber_id, body.lines, { subscriptionId: body.subscription_id }));
}));
api.post('/invoices/:id/charge', ah(async (req, res) => {
  res.json(await billing.chargeFromWallet(req.params.id));
}));
api.post('/billing/run-cycle', ah(async (_req, res) => res.json(await billing.runBillingCycle())));
api.post('/billing/run-dunning', ah(async (_req, res) => res.json(await billing.runDunning())));

// ----------------------------- Payments -----------------------------
api.post('/payments/mpesa/stk', ah(async (req, res) => {
  const body = parse(z.object({
    subscriber_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
    invoice_id: z.string().uuid().optional(),
  }), req.body);
  res.status(201).json(await payments.initiateMpesa({
    subscriberId: body.subscriber_id,
    amountCents: body.amount_cents,
    invoiceId: body.invoice_id,
  }));
}));
// M-Pesa Daraja calls this; also usable to confirm a simulated push.
api.post('/payments/mpesa/callback', ah(async (req, res) => {
  // Accept the real Daraja callback shape ({ Body: { stkCallback }}) or the
  // simple simulation shape ({ checkout_request_id, outcome }).
  const daraja = parseCallback(req.body);
  if (daraja) {
    await payments.confirmPayment(daraja.checkoutRequestId, daraja.success ? 'success' : 'failed', req.body);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // Daraja-required ack
  }
  const body = parse(z.object({
    checkout_request_id: z.string(),
    outcome: z.enum(['success', 'failed']).optional(),
  }), req.body);
  res.json(await payments.confirmPayment(body.checkout_request_id, body.outcome ?? 'success', req.body));
}));
api.post('/payments/stripe/topup', ah(async (req, res) => {
  const body = parse(z.object({
    subscriber_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
  }), req.body);
  res.status(201).json(await payments.topUpViaStripe({ subscriberId: body.subscriber_id, amountCents: body.amount_cents }));
}));
api.post('/payments/:ref/confirm', ah(async (req, res) => {
  res.json(await payments.confirmPayment(req.params.ref, req.body?.outcome ?? 'success', req.body ?? {}));
}));
api.get('/payments', ah(async (req, res) => {
  res.json(await payments.listPayments(req.query.subscriber_id as string | undefined));
}));

// -------------------------- Credit notes ----------------------------
api.get('/credit-notes', ah(async (req, res) => {
  res.json(await credits.listCreditNotes(req.query.subscriber_id as string | undefined));
}));
api.post('/credit-notes', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    subscriber_id: z.string().uuid(),
    amount_cents: z.number().int().positive(),
    reason: z.string().min(1),
    invoice_id: z.string().uuid().optional(),
  }), req.body);
  res.status(201).json(await credits.issueCreditNote({
    subscriberId: body.subscriber_id,
    amountCents: body.amount_cents,
    reason: body.reason,
    invoiceId: body.invoice_id,
  }));
}));

// ----------------------------- Refunds ------------------------------
api.get('/refunds', ah(async (req, res) => {
  res.json(await refunds.listRefunds(req.query.payment_id as string | undefined));
}));
api.post('/refunds', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    payment_id: z.string().uuid(),
    amount_cents: z.number().int().positive().optional(),
    reason: z.string().optional(),
    method: z.enum(['wallet', 'mpesa', 'manual']).optional(),
  }), req.body);
  res.status(201).json(await refunds.createRefund({
    paymentId: body.payment_id,
    amountCents: body.amount_cents,
    reason: body.reason,
    method: body.method,
  }));
}));

// ----------------------------- Vouchers -----------------------------
api.get('/vouchers', ah(async (req, res) => {
  res.json(await vouchers.listVouchers({
    batchId: req.query.batch_id as string | undefined,
    status: req.query.status as string | undefined,
  }));
}));
api.get('/voucher-batches', ah(async (_req, res) => res.json(await vouchers.listBatches())));
api.post('/vouchers/batch', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(5000),
    prefix: z.string().max(10).optional(),
    reseller_id: z.string().uuid().optional(),
    created_by: z.string().optional(),
  }), req.body);
  res.status(201).json(await vouchers.generateBatch({
    planId: body.plan_id,
    quantity: body.quantity,
    prefix: body.prefix,
    resellerId: body.reseller_id,
    createdBy: body.created_by,
  }));
}));
api.post('/vouchers/redeem', ah(async (req, res) => {
  const body = parse(z.object({
    code: z.string().min(4),
    subscriber_id: z.string().uuid(),
  }), req.body);
  res.json(await vouchers.redeem(body.code, body.subscriber_id));
}));

// ----------------------------- Resellers ----------------------------
api.get('/resellers', ah(async (_req, res) => res.json(await resellers.listResellers())));
api.post('/resellers', ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    commission_bps: z.number().int().min(0).optional(),
  }), req.body);
  res.status(201).json(await resellers.createReseller(body));
}));
api.get('/resellers/:id/wallet', ah(async (req, res) => {
  const w = await wallet.getWallet('reseller', req.params.id);
  if (!w) return res.json({ balance_cents: 0, entries: [] });
  res.json({ ...w, entries: await wallet.listLedger(w.id) });
}));
api.post('/resellers/:id/topup', ah(async (req, res) => {
  const body = parse(z.object({ amount_cents: z.number().int().positive() }), req.body);
  const w = await wallet.getOrCreateWallet('reseller', req.params.id);
  res.json(await wallet.credit(w.id, body.amount_cents, 'Reseller top-up', { type: 'topup' }));
}));

// ------------------------------- KYC --------------------------------
api.post('/subscribers/:id/kyc', ah(async (req, res) => {
  const body = parse(z.object({
    doc_type: z.enum(['id_card', 'passport', 'selfie', 'other']),
    filename: z.string().min(1),
    content_base64: z.string().min(1),
    content_type: z.string().optional(),
  }), req.body);
  res.status(201).json(await kyc.uploadDocument({
    subscriberId: req.params.id,
    docType: body.doc_type,
    filename: body.filename,
    contentBase64: body.content_base64,
    contentType: body.content_type,
  }));
}));
api.get('/subscribers/:id/kyc', ah(async (req, res) => res.json(await kyc.listForSubscriber(req.params.id))));
api.get('/kyc/:id/file', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const { buffer, doc } = await kyc.downloadDocument(req.params.id);
  res.setHeader('Content-Type', doc.content_type);
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
  res.send(buffer);
}));
api.post('/kyc/:id/review', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().optional() }), req.body);
  res.json(await kyc.review(req.params.id, body.decision, body.note));
}));

// ----------------------------- Routers ------------------------------
api.get('/routers', ah(async (_req, res) => res.json(await routers.listRouters())));
api.post('/routers', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1),
    host: z.string().min(1),
    api_port: z.number().int().positive().optional(),
    type: z.enum(['mikrotik', 'radius']).optional(),
    site: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }), req.body);
  res.status(201).json(await routers.createRouter(body));
}));
// Zero-touch provisioning: generates WG keypair + RouterOS .rsc script.
api.post('/routers/provision', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1),
    site: z.string().optional(),
  }), req.body);
  res.status(201).json(await routers.provisionRouter(body));
}));
api.post('/subscribers/:id/assign-router', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({ router_id: z.string().uuid() }), req.body);
  await routers.assignSubscriber(req.params.id, body.router_id);
  res.json({ ok: true });
}));

// ------------------------------ Usage -------------------------------
api.post('/usage', ah(async (req, res) => {
  const body = parse(z.object({
    subscriber_id: z.string().uuid(),
    bytes_in: z.number().int().nonnegative(),
    bytes_out: z.number().int().nonnegative(),
  }), req.body);
  res.json(await usage.ingestUsage({
    subscriberId: body.subscriber_id,
    bytesIn: body.bytes_in,
    bytesOut: body.bytes_out,
  }));
}));
api.get('/subscribers/:id/usage', ah(async (req, res) => {
  res.json(await usage.usageSummary(req.params.id));
}));
