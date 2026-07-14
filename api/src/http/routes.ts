import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from './helpers.js';
import { badRequest } from '../lib/errors.js';
import { currentTenantStatus, currentTenantUuid, runWithTenant } from '../db/pool.js';
import * as tenantPaybill from '../domains/platform/tenantPaybill.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import * as auth from '../domains/auth/service.js';
import * as settings from '../domains/settings/service.js';

// Auth endpoints are brute-force targets — limit by IP.
const loginLimit = rateLimit({ name: 'login', windowMs: 60_000, max: 10 });
const otpRequestLimit = rateLimit({ name: 'otp_req', windowMs: 60_000, max: 5 });
const otpVerifyLimit = rateLimit({ name: 'otp_vrf', windowMs: 60_000, max: 10 });

import * as plans from '../domains/plans/service.js';
import * as subscribers from '../domains/subscribers/service.js';
import * as subscriptions from '../domains/subscriptions/service.js';
import * as billing from '../domains/billing/service.js';
import * as payments from '../domains/payments/service.js';
import { parseCallback, stkPush } from '../domains/payments/daraja.js';
import * as c2b from '../domains/payments/c2b.js';
import * as collectionAccounts from '../domains/payments/collectionAccounts.js';
import * as bankStk from '../domains/payments/bankStk.js';
import * as unmatched from '../domains/payments/unmatched.js';
import * as dunning from '../domains/customers/dunning.js';
import * as jenga from '../domains/payments/jenga.js';
import * as intasend from '../domains/payments/intasend.js';
import * as kopokopo from '../domains/payments/kopokopo.js';
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
import * as radius from '../domains/radius/service.js';
import * as coa from '../domains/radius/coa.js';
import * as customers from '../domains/customers/service.js';
import * as hotspot from '../domains/hotspot/service.js';
import * as renew from '../domains/renew/service.js';
import { getTemplate as getHotspotTemplate, TEMPLATE_NAMES as HOTSPOT_TEMPLATE_NAMES } from '../domains/hotspot/templates.js';
import * as paymentEvents from '../domains/paymentEvents/service.js';
import * as hotspotDevices from '../domains/hotspotDevices/service.js';
import * as deviceTokens from '../domains/hotspotDevices/tokens.js';
import * as portal from '../domains/portal/service.js';
// customerWallet is consumed by routes/wallet.ts; routes.ts only needs
// the SMS resend helper which uses customerSms below.
import * as customerSms from '../domains/customers/notifications.js';
import * as alerts from '../domains/alerts/service.js';
import * as audit from '../domains/audit/service.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerReportsRoutes } from './routes/reports.js';
import { registerTwinRoutes } from './routes/twin.js';
import { registerLeadsRoutes } from './routes/leads.js';
import { registerAdsRoutes } from './routes/ads.js';
import { registerMessageTemplateRoutes } from './routes/messageTemplates.js';
import { registerTenantRoutes } from './routes/tenants.js';
import { registerPlatformRoutes } from './routes/platform.js';

export const api = Router();

// --- Suspension enforcement -------------------------------------------------
// When HubNet suspends a tenant (unpaid platform invoice), block the operator's
// dashboard/data API but DELIBERATELY keep customer-facing + money-in paths open
// so the ISP's end-users aren't punished and the ISP keeps earning to pay us.
// Allowed while suspended: auth, tenant status/signup, health, and the
// customer-facing captive-portal + payment-callback surfaces.
const SUSPEND_ALLOW: RegExp[] = [
  /^\/auth(\/|$)/, /^\/tenants(\/|$)/, /^\/health/, /^\/ready/, /^\/metrics/,
  /^\/hotspot(\/|$)/, /^\/renew(\/|$)/, /^\/portal(\/|$)/, /^\/payments(\/|$)/,
];
api.use((req, res, next) => {
  if (currentTenantStatus() === 'suspended' && !SUSPEND_ALLOW.some((re) => re.test(req.path))) {
    res.status(402).json({
      error: 'tenant_suspended',
      message: 'This ISP account is suspended pending payment to the platform operator.',
    });
    return;
  }
  next();
});

// Feature-bucketed sub-routers. Adding a new feature here keeps routes.ts
// from growing further — drop a routes/<feature>.ts file with a register()
// function and add one line below. Each sub-module owns its own imports +
// zod validation, so two features editing this file at once stop colliding.
registerNetworkRoutes(api);
registerTwinRoutes(api);
registerLeadsRoutes(api);
registerAdsRoutes(api);
registerMessageTemplateRoutes(api);
registerTenantRoutes(api);
registerPlatformRoutes(api);
registerWalletRoutes(api);
registerReportsRoutes(api);

// RADIUS CoA: instantly disconnect a live session (force re-auth) by username or
// MAC — the "kick now" / instant re-rate primitive. Operator/admin only.
api.post('/admin/radius/kick', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    username: z.string().optional(),
    mac: z.string().optional(),
  }).refine((b) => b.username || b.mac, 'username or mac required'), req.body);
  const results = body.username
    ? await coa.kickByUsername(body.username)
    : await coa.kickByMac(body.mac!);
  res.json({ sessions: results.length, acked: results.filter((r) => r.ok).length, results });
}));

// ------------------------------- Auth -------------------------------
// Staff/admin password login.
api.post('/auth/login', loginLimit, ah(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  res.json(await auth.loginPassword(body.username, body.password));
}));
// First-run: does any operator account exist? Drives the login-vs-signup UI.
api.get('/auth/setup-status', ah(async (_req, res) => res.json(await auth.setupStatus())));
// Bootstrap signup — creates the first admin only (refuses once one exists).
api.post('/auth/register', loginLimit, ah(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(3), password: z.string().min(6) }), req.body);
  res.json(await auth.registerFirstAdmin(body.username, body.password));
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

// ----------------------- Customer self-serve portal --------------------
// SMS-OTP login flow → /portal/me read → /portal/renew triggers M-Pesa STK.
// All gated by 'customer' role JWT issued from /portal/auth/verify.
api.post('/portal/auth/request', otpRequestLimit, ah(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(7) }), req.body);
  res.json(await auth.requestCustomerOtp(body.phone));
}));
api.post('/portal/auth/verify', otpVerifyLimit, ah(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(7), code: z.string().min(4) }), req.body);
  res.json(await auth.verifyCustomerOtp(body.phone, body.code));
}));
api.get('/portal/me', requireAuth('customer'), ah(async (req, res) => {
  res.json(await portal.getPortalMe(req.user!.sub));
}));

// Wallet routes (portal + admin) live in ./routes/wallet.ts.
// Operator-triggered SMS resend stays here — it's a customer-mutation
// adjacent to status_change/renew which haven't been extracted.
api.post('/admin/customers/:id/services/:serviceId/resend-onboarding',
  requireAuth('admin', 'staff'),
  ah(async (req, res) => {
    await customerSms.resendOnboarding(req.params.id, req.params.serviceId);
    res.json({ ok: true });
  }));

// Operator-initiated free-text message to one customer. Reuses the same
// per-channel fan-out as transactional notifications, so the send is logged
// and shows up in the customer's "Comms" tab. Returns sent/skipped counts so
// the UI can tell the operator honestly whether it actually went out.
// Rate-limited: each send spends the tenant's prepaid SMS balance, so cap it
// like the other cost-/abuse-sensitive endpoints. Channels are validated to be
// a NON-EMPTY set (omit the field to fall back to the customer's preferences).
const manualMsgLimit = rateLimit({ name: 'manual_msg', windowMs: 60_000, max: 10 });
api.post('/admin/customers/:id/message',
  manualMsgLimit,
  requireAuth('admin', 'staff'),
  ah(async (req, res) => {
    const body = parse(z.object({
      body: z.string().min(1).max(640),
      channels: z.array(z.enum(['sms', 'email', 'whatsapp'])).min(1).optional(),
    }), req.body);
    const result = await customerSms.sendManual(req.params.id, body.body, body.channels);
    // Attribute the send to the operator (the actor is already in ALS context
    // from requireAuth) so it appears in the customer's Activity audit feed —
    // a brand-attributed outbound message must be traceable to who sent it.
    audit.logAuditSafe({
      kind: 'customer.message',
      entity_type: 'customer',
      entity_id: req.params.id,
      metadata: {
        channels: body.channels ?? 'preferences',
        length: body.body.length,
        preview: body.body.slice(0, 80),
        sent: result.sent,
        skipped: result.skipped,
      },
    });
    res.json(result);
  }));

// Bulk operator message to a SET of customers (the operator's filtered customer
// list). Heavier + more cost-sensitive than a single send, so: lower rate limit,
// a hard recipient cap (narrow the filter for bigger sends), and an audit row.
// Each recipient is messaged via sendManual, so each gets its own Comms-tab row.
const bulkMsgLimit = rateLimit({ name: 'bulk_msg', windowMs: 60_000, max: 5 });
api.post('/admin/customers/message/bulk',
  bulkMsgLimit,
  requireAuth('admin', 'staff'),
  ah(async (req, res) => {
    // WhatsApp is intentionally NOT a bulk channel: it isn't metered against the
    // tenant's prepaid balance and free-text fails outside Meta's 24h window.
    // Recipient cap kept low (100) so a synchronous run stays well under any
    // reverse-proxy timeout; idempotencyKey makes a retry safe (no double-send).
    const b = parse(z.object({
      customerIds: z.array(z.string().uuid()).min(1).max(100),
      body: z.string().min(1).max(640),
      channels: z.array(z.enum(['sms', 'email'])).min(1).optional(),
      idempotencyKey: z.string().uuid().optional(),
    }), req.body);
    const result = await customerSms.sendBulk(b.customerIds, b.body, b.channels, b.idempotencyKey);
    audit.logAuditSafe({
      kind: 'customer.bulk_message',
      entity_type: 'customer',
      entity_id: 'bulk',
      metadata: {
        channels: b.channels ?? 'preferences',
        length: b.body.length,
        preview: b.body.slice(0, 80),
        idempotency_key: b.idempotencyKey ?? null,
        recipients: result.recipients,
        reached: result.reached,
        skipped: result.skipped,
        failed: result.failed,
      },
    });
    res.json(result);
  }));

// ----------------------------- Alerts --------------------------------
// Operator-facing health alerts (DLQ, queue backlog, router offline).
// Hourly worker fans out to Telegram automatically; these endpoints
// let the dashboard show / acknowledge alerts and trigger a manual sweep.
api.get('/admin/alerts', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const status = (typeof req.query.status === 'string' ? req.query.status : 'open') as any;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await alerts.listAlerts({ status, limit }));
}));
api.post('/admin/alerts/:id/ack', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const by = req.user?.username ? String(req.user.username) : String(req.user?.sub ?? 'admin');
  res.json(await alerts.ackAlert(req.params.id, by));
}));
api.post('/admin/alerts/evaluate', requireAuth('admin'), ah(async (_req, res) => {
  res.json(await alerts.runEvaluators());
}));

// Network monitoring routes live in ./routes/network.ts.
api.post('/portal/renew', requireAuth('customer'), ah(async (req, res) => {
  const body = parse(z.object({
    service_id: z.string().uuid(),
    plan_id: z.string().uuid(),
    phone: z.string().min(7),
  }), req.body);
  res.json(await portal.portalRenew({
    customerId: req.user!.sub,
    serviceId: body.service_id,
    planId: body.plan_id,
    phone: body.phone,
  }));
}));
// Status polling — reuse the existing hotspot getPurchaseStatus by
// importing it at the top of this file. The customer's JWT proves
// ownership of the parent checkoutRequestId (they initiated the renewal).
api.get('/portal/pay/:checkoutRequestId', requireAuth('customer'), ah(async (req, res) => {
  res.json(await hotspot.getPurchaseStatus(req.params.checkoutRequestId));
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
api.get('/plugins', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(listPlugins())));

// ---------------------------- Dashboard -----------------------------
api.get('/dashboard', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.dashboard())));
api.get('/dashboard/overview', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.overviewDashboard())));
api.get('/dashboard/nav-counts', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.navCounts())));
api.get('/dashboard/setup-status', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.setupStatus())));
api.get('/reports/revenue', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.revenueByMonth())));
api.get('/reports/top-plans', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.topPlans())));
api.get('/reports/churn', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await reports.churnAndMrr())));
api.get('/reports/payments.csv', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  const csv = await reports.paymentsCsv();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
  res.send(csv);
}));

// Unified revenue across legacy payments + hotspot_purchases. The /reports/revenue
// endpoint above only sees the legacy slice; this one is what the rebuilt
// Reports page calls.
// New reports (revenue-combined, by-plan, outstanding-renewals, pppoe-mrr,
// customers.csv, hotspot-purchases.csv) live in ./routes/reports.ts.

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
    validity_minutes: z.number().int().positive().optional(),
    data_cap_mb: z.number().int().positive().nullable().optional(),
    speed_down_kbps: z.number().int().positive().nullable().optional(),
    speed_up_kbps: z.number().int().positive().nullable().optional(),
    fup_threshold_pct: z.number().int().min(1).max(100).optional(),
  }), req.body);
  res.status(201).json(await plans.createPlan(body));
}));
api.get('/plans/:id', ah(async (req, res) => res.json(await plans.getPlan(req.params.id))));
api.patch('/plans/:id', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1).optional(),
    price_cents: z.number().int().nonnegative().optional(),
    billing_cycle: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
    validity_days: z.number().int().positive().optional(),
    validity_minutes: z.number().int().positive().optional(),
    data_cap_mb: z.number().int().positive().nullable().optional(),
    speed_down_kbps: z.number().int().positive().nullable().optional(),
    speed_up_kbps: z.number().int().positive().nullable().optional(),
    fup_threshold_pct: z.number().int().min(1).max(100).optional(),
    active: z.boolean().optional(),
  }), req.body);
  res.json(await plans.updatePlan(req.params.id, body));
}));

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
api.get('/invoices', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await billing.listInvoices())));
api.get('/invoices/:id', requireAuth('admin', 'staff'), ah(async (req, res) => res.json(await billing.getInvoice(req.params.id))));
api.get('/invoices/:id/pdf', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const { buffer, filename } = await getInvoicePdf(req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(buffer);
}));
api.post('/invoices', requireAuth('admin', 'staff'), ah(async (req, res) => {
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
api.post('/invoices/:id/charge', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await billing.chargeFromWallet(req.params.id));
}));
api.post('/billing/run-cycle', requireAuth('admin'), ah(async (_req, res) => res.json(await billing.runBillingCycle())));
api.post('/billing/run-dunning', requireAuth('admin'), ah(async (_req, res) => res.json(await billing.runDunning())));

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
// M-Pesa Daraja callback for SUBSCRIBER payments. Enqueue-only: the worker
// drains payment_events asynchronously so a slow settle path can never block
// the Daraja ACK (must return <10s or Daraja retries). The simulation shape
// ({checkout_request_id, outcome}) is still handled inline since it's
// developer-only and benefits from synchronous feedback.
api.post('/payments/mpesa/callback', ah(async (req, res) => {
  const daraja = parseCallback(req.body);
  if (daraja) {
    await paymentEvents.enqueue('mpesa_payment', daraja.checkoutRequestId, req.body);
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // Daraja-required ack
  }
  // Dev/simulation path — synchronous so the caller sees the settled row.
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
api.get('/payments', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await payments.listPayments(req.query.subscriber_id as string | undefined));
}));

// -------------------------- Credit notes ----------------------------
api.get('/credit-notes', requireAuth('admin', 'staff'), ah(async (req, res) => {
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
api.get('/refunds', requireAuth('admin', 'staff'), ah(async (req, res) => {
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
api.get('/vouchers', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await vouchers.listVouchers({
    batchId: req.query.batch_id as string | undefined,
    status: req.query.status as string | undefined,
  }));
}));
api.get('/voucher-batches', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await vouchers.listBatches())));
api.post('/vouchers/batch', requireAuth('admin', 'staff'), ah(async (req, res) => {
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
api.get('/resellers', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await resellers.listResellers())));
api.post('/resellers', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    commission_bps: z.number().int().min(0).optional(),
  }), req.body);
  res.status(201).json(await resellers.createReseller(body));
}));
api.get('/resellers/:id/wallet', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const w = await wallet.getWallet('reseller', req.params.id);
  if (!w) return res.json({ balance_cents: 0, entries: [] });
  res.json({ ...w, entries: await wallet.listLedger(w.id) });
}));
api.post('/resellers/:id/topup', requireAuth('admin'), ah(async (req, res) => {
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
api.get('/routers', requireAuth('admin', 'staff'), ah(async (_req, res) => res.json(await routers.listRouters())));
// Per-router device detail (System Information + RADIUS exposes secrets → admin).
api.get('/routers/:id', requireAuth('admin', 'staff'), ah(async (req, res) => res.json(await routers.getRouter(req.params.id))));
api.get('/routers/:id/system', requireAuth('admin'), ah(async (req, res) => res.json(await routers.getRouterSystem(req.params.id))));
api.get('/routers/:id/users', requireAuth('admin', 'staff'), ah(async (req, res) => res.json(await routers.getRouterUsers(req.params.id))));
api.get('/routers/:id/metrics', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json(await routers.getRouterMetrics(req.params.id, hours));
}));
// Device Events timeline (lifecycle + online/offline).
api.get('/routers/:id/events', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json(await routers.getRouterEvents(req.params.id, limit));
}));
// Payments collected through this router (hotspot purchases stamped router_id).
api.get('/routers/:id/payments', requireAuth('admin', 'staff'), ah(async (req, res) => res.json(await routers.getRouterPayments(req.params.id))));
// Live diagnostics (DB liveness + on-router SSH readings).
api.get('/routers/:id/diagnose', requireAuth('admin', 'staff'), ah(async (req, res) => res.json(await routers.diagnoseRouter(req.params.id))));
// Config backups — a full /export exposes the router config → admin only.
api.get('/routers/:id/backups', requireAuth('admin'), ah(async (req, res) => res.json(await routers.getRouterBackups(req.params.id))));
api.post('/routers/:id/backups', requireAuth('admin'), ah(async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : undefined;
  const by = req.user?.username ? String(req.user.username) : String(req.user?.sub ?? 'admin');
  res.json(await routers.createRouterBackup(req.params.id, note, by));
}));
api.get('/routers/:id/backups/:backupId', requireAuth('admin'), ah(async (req, res) => res.json(await routers.getRouterBackup(req.params.id, req.params.backupId))));
api.delete('/routers/:id/backups/:backupId', requireAuth('admin'), ah(async (req, res) => {
  await routers.deleteRouterBackup(req.params.id, req.params.backupId);
  res.json({ ok: true });
}));
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
// ---------------------- Customers + Services ----------------------
api.get('/customers', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await customers.listCustomers());
}));
api.get('/customers/:id', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await customers.getCustomer(req.params.id));
}));
api.post('/customers', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    account_number: z.string().optional(),
    full_name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    address: z.string().optional(),
    notes: z.string().optional(),
  }), req.body);
  res.status(201).json(await customers.createCustomer(body));
}));
api.put('/customers/:id', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    full_name: z.string().min(1).max(120).optional(),
    phone: z.string().max(20).nullable().optional(),
    email: z.string().max(120).nullable().optional(),
    address: z.string().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    status: z.enum(['active', 'suspended', 'closed']).optional(),
    notification_channels: z.array(z.enum(['sms', 'email', 'whatsapp'])).optional(),
  }), req.body);
  res.json(await customers.updateCustomer(req.params.id, body));
}));

// Customer self-serve channel preferences — mirrors the admin PUT but
// gated by the customer's own JWT, so a customer can opt in/out of
// channels from /portal without operator help.
api.put('/portal/notification-channels', requireAuth('customer'), ah(async (req, res) => {
  const body = parse(z.object({
    channels: z.array(z.enum(['sms', 'email', 'whatsapp'])),
  }), req.body);
  await customers.updateCustomer(req.user!.sub, { notification_channels: body.channels });
  res.json({ ok: true, channels: body.channels });
}));
api.get('/customers/:id/payments', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
  res.json(await customers.getCustomerPayments(req.params.id, limit));
}));
// Per-customer audit feed — every mutation against this customer or any
// of their services. Powers the "Activity" tab on the customer detail page.
api.get('/customers/:id/audit', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
  // Customer's own row events…
  const customerEvents = await audit.listAudit({ entity_type: 'customer', entity_id: req.params.id, limit });
  // …plus any service that belongs to them. Two queries kept simple — at
  // customer-page scale (handful of services) this is cheap.
  const services = await customers.getCustomer(req.params.id);
  const serviceIds = services.services.map((s) => s.id);
  const serviceEvents = serviceIds.length === 0 ? [] : (await Promise.all(
    serviceIds.map((sid) => audit.listAudit({ entity_type: 'service', entity_id: sid, limit }))
  )).flat();
  const merged = [...customerEvents, ...serviceEvents]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);
  res.json(merged);
}));
// Per-customer outbound comms history — every SMS / email / WhatsApp we've
// fired at this customer. Powers the "Comms" tab on the customer detail page.
api.get('/customers/:id/notifications', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 100;
  res.json(await customers.listCustomerNotifications(req.params.id, limit));
}));
// Global audit feed for compliance review and operator forensics.
api.get('/admin/audit', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 1000) : 200;
  res.json(await audit.listAudit({
    entity_type: typeof req.query.entity_type === 'string' ? req.query.entity_type : undefined,
    entity_id:   typeof req.query.entity_id === 'string'   ? req.query.entity_id   : undefined,
    actor_id:    typeof req.query.actor_id === 'string'    ? req.query.actor_id    : undefined,
    kind:        typeof req.query.kind === 'string'        ? req.query.kind        : undefined,
    since:       typeof req.query.since === 'string'       ? req.query.since       : undefined,
    limit,
  }));
}));
// CSV export of the audit feed (same filters as /admin/audit) for compliance /
// offline review. before/after/metadata are serialized as JSON columns.
api.get('/admin/audit.csv', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const rows = await audit.listAudit({
    entity_type: typeof req.query.entity_type === 'string' ? req.query.entity_type : undefined,
    entity_id:   typeof req.query.entity_id === 'string'   ? req.query.entity_id   : undefined,
    actor_id:    typeof req.query.actor_id === 'string'    ? req.query.actor_id    : undefined,
    kind:        typeof req.query.kind === 'string'        ? req.query.kind        : undefined,
    since:       typeof req.query.since === 'string'       ? req.query.since       : undefined,
    limit:       req.query.limit ? Math.min(Number(req.query.limit), 10000) : 5000,
  });
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['created_at', 'kind', 'entity_type', 'entity_id', 'actor_label', 'actor_role', 'metadata', 'before', 'after'];
  const lines = [header.join(',')];
  for (const r of rows as any[]) {
    lines.push([r.created_at, r.kind, r.entity_type, r.entity_id, r.actor_label, r.actor_role, r.metadata, r.before, r.after].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
  res.send(lines.join('\n'));
}));
api.get('/services/:id/sessions', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 20;
  res.json(await customers.getRecentSessions(req.params.id, limit));
}));
api.post('/customers/:id/services', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    service_type: z.enum(['pppoe', 'hotspot', 'static', 'ftth_gpon']),
    username: z.string().optional(),
    password: z.string().optional(),
    ip_address: z.string().optional(),
    mac_address: z.string().optional(),
    vlan_id: z.number().int().optional(),
    router_id: z.string().uuid().optional(),
    plan_id: z.string().uuid().optional(),
    rate_limit: z.string().optional(),
    expiry_date: z.string().optional(),
  }), req.body);
  res.status(201).json(await customers.createService({ ...body, customer_id: req.params.id }));
}));
api.patch('/services/:id/status', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    status: z.enum(['active', 'suspended', 'expired', 'cancelled']),
  }), req.body);
  res.json(await customers.setServiceStatus(req.params.id, body.status));
}));
// Force-renew: operator-side top-up that bypasses M-Pesa. Bumps expiry by
// the supplied plan's validity_days and restores status to 'active'.
// fromNow=false stacks onto the existing expiry (loyal customer with time
// left); fromNow=true restarts the window (reactivating after expiry).
api.post('/services/:id/renew', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    planId: z.string().uuid().optional(),
    fromNow: z.boolean().optional(),
  }), req.body);
  res.json(await customers.renewService({
    serviceId: req.params.id,
    planId: body.planId,
    fromNow: body.fromNow,
  }));
}));
// Mid-cycle plan change. Swaps plan_id + rate_limit; expiry_date untouched
// so the customer keeps the days they paid for. Use /renew if the operator
// wants to also reset the billing window.
api.patch('/services/:id/plan', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({ planId: z.string().uuid() }), req.body);
  res.json(await customers.changePlan({ serviceId: req.params.id, planId: body.planId }));
}));
// Admin trigger for the auto-expire sweep (also runs hourly via the worker).
api.post('/admin/services/expire-sweep', requireAuth('admin'), ah(async (_req, res) => {
  res.json({ expired: await customers.expireDueServices() });
}));
// Bulk import: paste N (full_name, phone, ...) rows + one plan_id, mint
// customers + PPPoE services in batch. Per-row isolation — one bad row
// doesn't roll back the others. Response contains the generated creds
// per row so the operator can SMS them in turn.
api.post('/admin/customers/bulk-import', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    router_id: z.string().uuid().optional(),
    rows: z.array(z.object({
      full_name: z.string().min(1).max(120),
      phone: z.string().max(20).optional(),
      email: z.string().max(120).optional(),
      address: z.string().max(200).optional(),
      username: z.string().max(60).optional(),
      password: z.string().min(6).max(60).optional(),
    })).min(1).max(500),
  }), req.body);
  res.json(await customers.bulkCreateCustomers({
    rows: body.rows,
    plan_id: body.plan_id,
    router_id: body.router_id,
  }));
}));
api.delete('/services/:id', requireAuth('admin', 'staff'), ah(async (req, res) => {
  await customers.deleteService(req.params.id);
  res.status(204).end();
}));

// ---------------------- Settings ----------------------
// Admin-configurable runtime config. Secrets are write-only via the API:
// GET returns whether a key is set, never its value.
api.get('/settings/mpesa', requireAuth('admin'), ah(async (_req, res) => {
  res.json(await settings.getMpesaConfigPublic());
}));
api.put('/settings/mpesa', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    env: z.enum(['sandbox', 'production']).optional(),
    shortcode: z.string().optional(),
    till: z.string().optional(),
    accountName: z.string().optional(),
    accountNo: z.string().optional(),
    bankProvider: z.enum(['', 'equity_jenga', 'kcb']).optional(),
    bankProviderEnv: z.enum(['sandbox', 'live']).optional(),
    consumerKey: z.string().optional(),
    consumerSecret: z.string().optional(),
    passkey: z.string().optional(),
    collectionMethod: z.enum(['stk', 'paybill', 'till', 'bank', 'intasend', 'kopokopo']).optional(),
  }), req.body);
  // For no-API methods, claim the routing key for shared-callback routing FIRST
  // (rejects a key already owned by another ISP) before persisting settings.
  // paybill/till route on the shortcode/till; bank routes on the account NUMBER
  // because banks share a paybill (e.g. every Equity ISP uses 247247).
  const uuid = currentTenantUuid();
  if (uuid && body.collectionMethod === 'bank') {
    await tenantPaybill.registerPaybill(body.shortcode ?? '', uuid, 'bank', body.accountNo);
  } else if (uuid && (body.collectionMethod === 'paybill' || body.collectionMethod === 'till')) {
    const num = body.collectionMethod === 'till' ? body.till : body.shortcode;
    if (num) await tenantPaybill.registerPaybill(num, uuid, body.collectionMethod);
  }
  await settings.setMpesaConfig(body, (req.user as { username?: string } | undefined)?.username);
  res.json(await settings.getMpesaConfigPublic());
}));
// Fire a live STK push to validate the saved Daraja creds end-to-end (prompt ->
// callback). Small default amount; uses the hotspot callback path so a real pay
// also exercises settlement. Returns the Daraja error verbatim on failure.
api.post('/settings/mpesa/test', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    phone: z.string().min(7),
    amount: z.number().int().positive().optional(),
  }), req.body);
  try {
    const r = await stkPush({
      phone: body.phone,
      amountKes: body.amount ?? 1,
      accountReference: 'TEST',
      description: 'STK test',
      callbackUrl: `${config.publicApiUrl}/api/hotspot/mpesa/callback`,
    });
    res.json({ ok: true, checkoutRequestId: r.checkoutRequestId, customerMessage: r.customerMessage });
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? 'STK push failed' });
  }
}));

// ---------- M-Pesa C2B (your own Paybill) ----------
// One-time: register C2B confirmation/validation URLs with Safaricom for your shortcode.
api.post('/settings/mpesa/register-c2b', requireAuth('admin'), ah(async (_req, res) => {
  res.json(await c2b.registerC2bUrls());
}));

// ---------- Collection accounts (per-router no-API destinations) ----------
// An ISP's paybill/till/bank destinations; each router can be pinned to one
// (else the default collects). Creating/updating claims the destination in the
// shared-callback registry so incoming confirmations route back to this tenant.
const collectionAccountBody = z.object({
  label: z.string().min(1).max(80),
  method: z.enum(['paybill', 'till', 'bank']),
  paybill: z.string().max(20).optional(),
  till: z.string().max(20).optional(),
  account_no: z.string().max(40).optional(),
  account_name: z.string().max(120).optional(),
  is_default: z.boolean().optional(),
});
api.get('/settings/collection-accounts', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await collectionAccounts.listCollectionAccounts());
}));
api.post('/settings/collection-accounts', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(collectionAccountBody, req.body);
  res.status(201).json(await collectionAccounts.createCollectionAccount(body));
}));
api.put('/settings/collection-accounts/:id', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(collectionAccountBody, req.body);
  res.json(await collectionAccounts.updateCollectionAccount(req.params.id, body));
}));
api.post('/settings/collection-accounts/:id/default', requireAuth('admin'), ah(async (req, res) => {
  res.json(await collectionAccounts.setDefaultCollectionAccount(req.params.id));
}));
api.delete('/settings/collection-accounts/:id', requireAuth('admin'), ah(async (req, res) => {
  await collectionAccounts.deleteCollectionAccount(req.params.id);
  res.status(204).end();
}));
// ---------- Auto-STK renewal dunning (opt-in) ----------
// Config + a live preview of who'd be prompted + a manual run trigger.
api.get('/settings/renewal-dunning', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  const config = await dunning.getDunningConfig();
  const eligible = (await dunning.dunningTargets(config)).length;
  res.json({ ...config, eligible });
}));
api.put('/settings/renewal-dunning', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    windowHours: z.number().int().min(1).max(168).optional(),
    graceHours: z.number().int().min(0).max(720).optional(),
  }), req.body);
  const config = await dunning.setDunningConfig(body);
  const eligible = (await dunning.dunningTargets(config)).length;
  res.json({ ...config, eligible });
}));
api.get('/settings/renewal-dunning/preview', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  const config = await dunning.getDunningConfig();
  res.json(await dunning.dunningTargets(config));
}));
api.post('/settings/renewal-dunning/run', requireAuth('admin'), ah(async (_req, res) => {
  res.json(await dunning.runStkDunningOnce());
}));

// ---------- Payment reconciliation (unmatched payments) ----------
// Confirmations that arrived without matching a pending purchase. Operators
// recover them (claim -> grant) or dismiss them.
api.get('/payments/unmatched', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'unmatched';
  res.json(await unmatched.listUnmatched(status));
}));
api.get('/payments/unmatched/stats', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await unmatched.unmatchedStats());
}));
api.post('/payments/unmatched/:id/claim', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    phone: z.string().optional(),
    mac: z.string().optional(),
  }), req.body);
  res.json(await unmatched.claimUnmatched(
    req.params.id, { planId: body.plan_id, phone: body.phone, mac: body.mac },
    (req.user as { username?: string } | undefined)?.username
  ));
}));
api.post('/payments/unmatched/:id/ignore', requireAuth('admin', 'staff'), ah(async (req, res) => {
  await unmatched.ignoreUnmatched(req.params.id, (req.user as { username?: string } | undefined)?.username);
  res.json({ ok: true });
}));

// Assign (or clear) the collection account a router collects into.
api.put('/routers/:id/collection-account', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({ collection_account_id: z.string().uuid().nullable() }), req.body);
  await collectionAccounts.setRouterCollectionAccount(req.params.id, body.collection_account_id);
  res.json({ ok: true });
}));

// ---------- Bank STK providers (Equity JengaHQ / KCB) ----------
// Per-tenant merchant API credentials for firing the bank's own STK Push so a
// bank collection account can prompt the customer and deposit DIRECTLY into the
// ISP's bank account. Secrets are write-only (GET returns only *Set booleans).
api.get('/settings/bank-providers', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await Promise.all(bankStk.BANK_PROVIDERS.map((p) => bankStk.getBankProviderPublic(p))));
}));
api.put('/settings/bank-providers/:provider', requireAuth('admin'), ah(async (req, res) => {
  const provider = req.params.provider;
  if (!bankStk.isBankProvider(provider)) throw badRequest('unknown bank provider');
  const body = parse(z.object({
    merchantCode: z.string().optional(),
    consumerKey: z.string().optional(),
    consumerSecret: z.string().optional(),
    apiKey: z.string().optional(),
    signingKey: z.string().optional(),
  }), req.body);
  await bankStk.setBankProvider(provider, body, (req.user as { username?: string } | undefined)?.username);
  res.json(await bankStk.getBankProviderPublic(provider));
}));
// IntaSend aggregator settings (env + keys + webhook challenge).
api.get('/settings/intasend', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await settings.getIntasendConfigPublic());
}));
api.put('/settings/intasend', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    env: z.enum(['sandbox', 'live']).optional(),
    publicKey: z.string().optional(),
    secretKey: z.string().optional(),
    challenge: z.string().optional(),
  }), req.body);
  await settings.setIntasendConfig(body, (req.user as { username?: string } | undefined)?.username);
  res.json(await settings.getIntasendConfigPublic());
}));
// Safaricom C2B confirmation — match by account-ref (phone) + amount, settle, grant.
// Always ACK 0 so Safaricom doesn't retry-storm; matching/settlement is internal.
api.post('/payments/c2b/confirmation', ah(async (req, res) => {
  try { await c2b.handleC2bConfirmation(req.body); }
  catch (e) { console.error('[c2b] confirmation error', e); }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));
// C2B validation (only invoked if external validation is enabled on the shortcode). Accept all.
api.post('/payments/c2b/validation', ah(async (_req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));
// Defence-in-depth on the shared endpoints: optional shared-secret token (set on
// the registered URL) + optional Safaricom source-IP allowlist. Returns true if
// the caller is trusted (or no checks configured). The reference-match + dedup +
// amount guards in the settlement engine are the always-on backstop.
function sharedCallbackTrusted(req: import('express').Request): boolean {
  const tok = config.control.sharedCallbackToken;
  if (tok && req.query.token !== tok) {
    console.warn('[shared] rejected: bad/missing token');
    return false;
  }
  const allow = config.control.safaricomIps;
  if (allow.length) {
    const ip = (req.ip ?? '').replace('::ffff:', '');
    if (!allow.some((a) => ip === a || ip.startsWith(a))) {
      console.warn(`[shared] rejected: source IP ${ip} not in allowlist`);
      return false;
    }
  }
  return true;
}

// SHARED callback — ONE HubNet URL for all no-API tenants. Money already went to
// the ISP's own Paybill/Till; here we read the receiving BusinessShortCode,
// resolve which tenant owns it, and settle the payment in THAT tenant's database
// (reference match -> grant). Tenant is picked by shortcode, not by Host.
api.post('/payments/shared/confirmation', ah(async (req, res) => {
  try {
    if (!sharedCallbackTrusted(req)) { res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); return; }
    const p = req.body ?? {};
    const shortcode = String(p.BusinessShortCode ?? p.BusinessShortcode ?? p.shortCode ?? p.ShortCode ?? '').trim();
    const t = await tenantPaybill.resolvePaybill(shortcode);
    if (t && t.status === 'active') {
      const tp = tenantPaybill.poolForResolved(t);
      await runWithTenant({ tenantId: t.slug, pool: tp, uuid: t.id, status: t.status }, () => c2b.handleC2bConfirmation(p));
    } else {
      console.warn(`[shared-c2b] no active tenant for shortcode "${shortcode}"`);
    }
  } catch (e) {
    console.error('[shared-c2b] error', e);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // always ack — no retry-storm
}));
api.post('/payments/shared/validation', ah(async (_req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));
// SHARED bank/Jenga IPN — ONE HubNet URL for all bank-paybill ISPs. Resolve the
// tenant by the merchant account/paybill that received the money, then settle in
// that tenant's DB. (Per-host /payments/jenga/ipn still works for single-tenant.)
api.post('/payments/shared/jenga/ipn', ah(async (req, res) => {
  try {
    if (!sharedCallbackTrusted(req)) { res.json({ status: 'success' }); return; }
    const p = req.body ?? {};
    // Banks share a paybill; the per-ISP routing key is the destination account
    // number the bank's IPN echoes back.
    const merchant = jenga.resolveJengaMerchant(p);
    const t = await tenantPaybill.resolveBankAccount(merchant);
    if (t && t.status === 'active') {
      const tp = tenantPaybill.poolForResolved(t);
      await runWithTenant({ tenantId: t.slug, pool: tp, uuid: t.id, status: t.status }, () => jenga.handleJengaIpn(p));
    } else {
      console.warn(`[shared-jenga] no active tenant for account "${merchant}" — raw: ${JSON.stringify(p)}`);
    }
  } catch (e) {
    console.error('[shared-jenga] error', e);
  }
  res.json({ status: 'success' }); // always 200 — no retry-storm
}));
// Authed: the shared callback/IPN URLs (with token) for an ISP to register at
// their bank/Safaricom. Same for every tenant — routing is by paybill number.
api.get('/payments/shared-callback-info', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  const q = config.control.sharedCallbackToken ? `?token=${encodeURIComponent(config.control.sharedCallbackToken)}` : '';
  const base = `https://${config.control.sharedPayHost}/api/payments/shared`;
  res.json({
    confirmationUrl: `${base}/confirmation${q}`,
    validationUrl: `${base}/validation${q}`,
    jengaUrl: `${base}/jenga/ipn${q}`,
  });
}));
// Create a pending C2B purchase (no STK) + return Pay-Bill instructions; the
// portal shows these and polls /hotspot/pay/:id until the confirmation settles it.
api.post('/hotspot/pay-c2b', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    phone: z.string().min(7),
    mac: z.string().optional(),
    nas: z.string().optional(),
    slug: z.string().optional(),
  }), req.body);
  res.status(201).json(await c2b.initC2bPurchase({
    planId: body.plan_id, phone: body.phone, mac: body.mac,
    nas: body.nas, slug: body.slug,
    userAgent: req.headers['user-agent'],
  }));
}));
// Public: tells the captive portal which payment flow to run (STK vs C2B paybill
// vs till vs bank). When the customer's router (by NAS address or brand slug)
// has its own collection account — or the tenant has a default one — that
// no-API destination wins over the global M-Pesa config.
api.get('/hotspot/pay-config', ah(async (req, res) => {
  const m = await settings.getMpesaConfigPublic();
  const nas = typeof req.query.nas === 'string' ? req.query.nas : undefined;
  const slug = typeof req.query.slug === 'string' ? req.query.slug : undefined;
  const { account } = await collectionAccounts.resolveForRouter({ nas, slug, globalMethod: m.collectionMethod });
  if (account) {
    res.json({
      collectionMethod: account.method,
      paybill: account.method === 'till' ? '' : account.paybill,
      till: account.till,
      accountName: account.account_name,
      accountNo: account.account_no,
    });
    return;
  }
  res.json({
    collectionMethod: m.collectionMethod,
    paybill: m.shortcode,
    till: m.till,
    accountName: m.accountName,
    accountNo: m.accountNo,
  });
}));
// Jenga / Equity (JengaHQ) IPN webhook for bank-paybill collections. Maps the
// Jenga payload into the shared C2B settlement engine (reference match -> grant).
// Always 200 so Jenga doesn't retry-storm; matching is internal. Optional
// shared secret: set JENGA_IPN_TOKEN and register the callback URL with
// ?token=<that value> so only Jenga's posts are accepted.
api.post('/payments/jenga/ipn', ah(async (req, res) => {
  const expected = process.env.JENGA_IPN_TOKEN;
  if (expected && req.query.token !== expected) {
    return res.status(401).json({ status: 'unauthorized' });
  }
  try { await jenga.handleJengaIpn(req.body); }
  catch (e) { console.error('[jenga-ipn] handler error:', e); }
  res.json({ status: 'success' });
}));
// IntaSend collection webhook — verify challenge, map api_ref -> our reference, grant.
api.post('/payments/intasend/webhook', ah(async (req, res) => {
  try { await intasend.handleIntasendWebhook(req.body); }
  catch (e) { console.error('[intasend-webhook] handler error:', e); }
  res.status(200).json({ status: 'ok' }); // always ack so IntaSend doesn't retry-storm
}));
// Portal: create pending + fire an IntaSend M-Pesa STK push (api_ref = HUB reference).
api.post('/hotspot/pay-intasend', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string(),
    phone: z.string().min(7),
    mac: z.string().optional(),
  }), req.body);
  res.status(201).json(await intasend.initIntasendPurchase({
    planId: body.plan_id, phone: body.phone, mac: body.mac,
    userAgent: req.headers['user-agent'],
  }));
}));

// ---------- Kopo Kopo aggregator ----------
api.get('/settings/kopokopo', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await settings.getKopokopoConfigPublic());
}));
api.put('/settings/kopokopo', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    env: z.enum(['sandbox', 'live']).optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    tillNumber: z.string().optional(),
    apiKey: z.string().optional(),
  }), req.body);
  await settings.setKopokopoConfig(body, (req.user as { username?: string } | undefined)?.username);
  res.json(await settings.getKopokopoConfigPublic());
}));
// Kopo Kopo result webhook — on 'Received' map metadata.reference -> grant.
api.post('/payments/kopokopo/webhook', ah(async (req, res) => {
  try { await kopokopo.handleKopokopoWebhook(req.body); }
  catch (e) { console.error('[kopokopo-webhook] handler error:', e); }
  res.status(200).json({ status: 'ok' }); // always ack so K2 doesn't retry-storm
}));
// Portal: create pending + fire a Kopo Kopo STK push. callback_url uses THIS
// host so the webhook routes back to the right tenant.
api.post('/hotspot/pay-kopokopo', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string(),
    phone: z.string().min(7),
    mac: z.string().optional(),
  }), req.body);
  const base = `${req.protocol}://${req.get('host')}`;
  res.status(201).json(await kopokopo.initKopokopoPurchase({
    planId: body.plan_id, phone: body.phone, mac: body.mac,
    userAgent: req.headers['user-agent'],
  }, base));
}));

// ---------- SMS provider settings ----------
// Same DB-overrides-env pattern as M-Pesa. Provider switch is hot — no
// redeploy needed; the africastalking/bytwave clients read getSmsConfig()
// on every send. Test endpoint lets the operator fire a single SMS to
// any number to confirm provider creds work before relying on them.
api.get('/settings/sms', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await settings.getSmsConfigPublic());
}));
api.put('/settings/sms', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    provider: z.enum(['africastalking', 'bytwave']).optional(),
    africastalking: z.object({
      username: z.string().optional(),
      apiKey:   z.string().optional(),
      senderId: z.string().optional(),
    }).optional(),
    bytwave: z.object({
      apiKey:        z.string().optional(),
      endpoint:      z.string().url().optional(),
      senderId:      z.string().optional(),
      payloadFormat: z.enum(['json', 'form']).optional(),
    }).optional(),
  }), req.body);
  await settings.setSmsConfig(body, (req.user as { username?: string } | undefined)?.username);
  res.json(await settings.getSmsConfigPublic());
}));
api.post('/settings/sms/test', requireAuth('admin'), ah(async (req, res) => {
  // Wrap the WHOLE handler so any sync throw (normalizeMsisdn validation,
  // DB error, missing import) returns a JSON body with the exception
  // detail rather than a generic 500 from ah(). The dashboard toast
  // shows whatever ends up in `detail`.
  let phase = 'parse';
  try {
    const body = parse(z.object({
      phone: z.string().min(7),
      message: z.string().max(160).optional(),
    }), req.body);

    phase = 'normalize';
    // normalizeMsisdn throws on anything that isn't a recognised Kenyan
    // mobile format. Fall back to the raw input so unusual numbers (or
    // international ones) still hit the provider for a real-world error.
    const { normalizeMsisdn } = await import('../domains/payments/daraja.js');
    let normalized = String(body.phone).trim();
    try { normalized = normalizeMsisdn(normalized); } catch { /* keep raw */ }

    phase = 'config';
    const smsCfg = await settings.getSmsConfig();
    const apiKey = smsCfg.provider === 'bytwave'
      ? smsCfg.bytwave.apiKey
      : smsCfg.africastalking.apiKey;
    const text = body.message ?? `Test SMS from ${smsCfg.provider} via JTM at ${new Date().toISOString()}`;

    if (!apiKey) {
      return res.json({
        ok: false,
        provider: smsCfg.provider,
        sent_to: normalized,
        message: text,
        detail: `No API key for ${smsCfg.provider}. Saved key may not have persisted — re-paste in the ${smsCfg.provider} section and Save.`,
        simulated: true,
      });
    }

    phase = 'dispatch';
    let result: { ok: boolean; detail: string };
    if (smsCfg.provider === 'bytwave') {
      const { sendBytwaveSms } = await import('../domains/notifications/bytwave.js');
      result = await sendBytwaveSms(normalized, text);
    } else {
      const { sendSms } = await import('../domains/notifications/africastalking.js');
      result = await sendSms(normalized, text);
    }
    // Mirror the result to the API log so the operator can confirm
    // outcome from Render's log stream even when the dashboard toast
    // gets dismissed or the browser network tab is closed. Include the
    // endpoint URL so DNS / typo failures are immediately visible.
    const endpoint = smsCfg.provider === 'bytwave'
      ? smsCfg.bytwave.endpoint
      : 'africastalking';
    console.log(
      `[sms-test] provider=${smsCfg.provider} endpoint=${endpoint} ` +
      `to=${normalized} ok=${result.ok} ` +
      `detail=${JSON.stringify(result.detail).slice(0, 200)}`
    );
    return res.json({
      ok: result.ok,
      provider: smsCfg.provider,
      sent_to: normalized,
      message: text,
      detail: result.detail,
    });
  } catch (err) {
    // Surface the actual exception type + message so the toast shows
    // something useful. status 200 with ok:false so the UI gets the body.
    const e = err as Error;
    return res.json({
      ok: false,
      provider: 'unknown',
      sent_to: null,
      message: null,
      detail: `exception during ${phase}: ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`,
    });
  }
}));

// Reset endpoint — wipes every sms.* row from the settings table so the
// hardcoded defaults in config.ts take over. Use when the DB-saved
// endpoint URL or key is wrong and you just want a clean slate.
api.post('/settings/sms/reset', requireAuth('admin'), ah(async (_req, res) => {
  const { query } = await import('../db/pool.js');
  const r = await query(`DELETE FROM settings WHERE key LIKE 'sms.%'`);
  res.json({ ok: true, deleted_rows: r.rowCount ?? 0 });
}));

// Debug endpoint — shows what the SMS dispatcher will actually use,
// with secrets redacted. Use to confirm DB settings persisted correctly
// when the test endpoint is silently simulating.
api.get('/settings/sms/debug', requireAuth('admin'), ah(async (_req, res) => {
  const cfg = await settings.getSmsConfig();
  const pub = await settings.getSmsConfigPublic();
  const activeKey = cfg.provider === 'bytwave' ? cfg.bytwave.apiKey : cfg.africastalking.apiKey;
  res.json({
    active_provider: cfg.provider,
    active_provider_key_set: !!activeKey,
    active_provider_key_length: activeKey?.length ?? 0,
    will_simulate: !activeKey,
    africastalking: {
      username: cfg.africastalking.username,
      sender_id: cfg.africastalking.senderId,
      api_key_set: pub.africastalking.apiKeySet,
      api_key_length: cfg.africastalking.apiKey?.length ?? 0,
    },
    bytwave: {
      endpoint: cfg.bytwave.endpoint,
      sender_id: cfg.bytwave.senderId,
      payload_format: cfg.bytwave.payloadFormat,
      api_key_set: pub.bytwave.apiKeySet,
      api_key_length: cfg.bytwave.apiKey?.length ?? 0,
    },
  });
}));

// ---------------------- Hotspot captive portal ----------------------
// Public endpoint — gated by the voucher code being unguessable, not auth.
// The captive portal page calls this with the voucher code from the customer.
// ---------------------- Expired captive renew ----------------------
// Public — customer reaches /renew via the captive redirect. We look up
// their service and offer M-Pesa pay to restore it.
api.get('/renew/info', ah(async (req, res) => {
  res.json(await renew.getInfo({
    customer: typeof req.query.customer === 'string' ? req.query.customer : undefined,
    service: typeof req.query.service === 'string' ? req.query.service : undefined,
    username: typeof req.query.username === 'string' ? req.query.username : undefined,
    ip: typeof req.query.ip === 'string' ? req.query.ip : undefined,
  }));
}));
api.post('/renew/pay', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    phone: z.string().min(7),
    service_id: z.string().uuid(),
  }), req.body);
  res.json(await renew.pay({
    planId: body.plan_id,
    phone: body.phone,
    serviceId: body.service_id,
  }));
}));

api.post('/hotspot/redeem', ah(async (req, res) => {
  const body = parse(z.object({
    code: z.string().min(1),
    mac: z.string().optional(),
  }), req.body);
  res.json(await hotspot.redeemVoucher(body));
}));

// Hotspot plan list — only active plans of type=hotspot, returned to the portal.
api.get('/hotspot/plans', ah(async (_req, res) => {
  res.json(await listHotspotPlansInline());
}));

// Kick off an M-Pesa STK push for a hotspot plan.
api.post('/hotspot/pay', ah(async (req, res) => {
  const body = parse(z.object({
    plan_id: z.string().uuid(),
    phone: z.string().min(7),
    mac: z.string().optional(),
  }), req.body);
  res.status(201).json(await hotspot.initPurchase({
    planId: body.plan_id, phone: body.phone, mac: body.mac,
    userAgent: req.headers['user-agent'],
  }));
}));

// Portal polls this every few seconds while waiting for the STK callback.
// fp= query param carries the browser fingerprint so the inline-minted
// token captures it for future fingerprint-reconnect lookups.
api.get('/hotspot/pay/:checkoutRequestId', ah(async (req, res) => {
  const fp = typeof req.query.fp === 'string' && req.query.fp.length >= 32 ? req.query.fp : undefined;
  res.json(await hotspot.getPurchaseStatus(req.params.checkoutRequestId, { fingerprintHash: fp }));
}));

// ---------------------- Returning-customer auto-auth ----------------------
// Public lookup: portal calls this on mount with the MikroTik-supplied MAC.
// Returns {active:true, ...creds} if the MAC has a live grant (paid recently
// OR rebound via SMS-OTP). Portal short-circuits the captive UI and auto-
// submits the MikroTik login form with the returned credentials.
//
// Rate-limited: an unprotected lookup endpoint lets a LAN attacker enumerate
// MAC presence + masked phone (privacy leak per security review). 60/min/IP
// is generous for the legitimate flow (one portal load per reconnect) and
// hostile to enumeration.
const hotspotLookupLimit = rateLimit({ name: 'hotspot_lookup', windowMs: 60_000, max: 60 });
api.get('/hotspot/lookup', hotspotLookupLimit, ah(async (req, res) => {
  const mac = typeof req.query.mac === 'string' ? req.query.mac : '';
  res.json(await hotspotDevices.lookup(mac));
}));

// Rich session info for the status page: plan name, voucher code, expiry,
// data cap, bytes used. Public — the data is for the customer's own MAC.
api.get('/hotspot/session-info', ah(async (req, res) => {
  const mac = typeof req.query.mac === 'string' ? req.query.mac : '';
  const info = await hotspotDevices.getSessionInfo(mac);
  if (!info) return res.json({ found: false });
  res.json({ found: true, ...info });
}));

// Public: SMS-OTP MAC rebind for randomized-MAC recovery. Customer paid
// yesterday on MAC A, today their phone uses MAC B (iOS Private Wi-Fi
// Address). Enters their phone, gets SMS OTP, verifies, grant copies
// onto MAC B and they're online without re-paying.
api.post('/hotspot/rebind/start', ah(async (req, res) => {
  const body = parse(z.object({
    phone: z.string().min(7),
    mac: z.string().min(11),
  }), req.body);
  res.json(await hotspotDevices.rebindStart({
    phone: body.phone,
    newMac: body.mac,
    sourceIp: req.ip,
    userAgent: req.headers['user-agent'],
  }));
}));
api.post('/hotspot/rebind/verify', ah(async (req, res) => {
  const body = parse(z.object({
    otpId: z.string().uuid(),
    code: z.string().min(4).max(8),
    fingerprint: z.string().min(32).max(128).optional(),
  }), req.body);
  res.json(await hotspotDevices.rebindVerify({
    otpId: body.otpId,
    code: body.code,
    fingerprintHash: body.fingerprint ?? null,
  }));
}));

// Admin: live device list + manual revoke.
api.get('/admin/active-devices', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const liveOnly = req.query.live !== 'false';
  const phone = typeof req.query.phone === 'string' ? req.query.phone : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await hotspotDevices.listDevices({ liveOnly, phone, limit }));
}));
api.delete('/admin/active-devices/:mac', requireAuth('admin'), ah(async (req, res) => {
  await hotspotDevices.revoke(req.params.mac);
  res.json({ ok: true });
}));

// ---------------------- Sprint 2.5: device-token silent re-auth ----------------------
// Survives MAC randomization without SMS friction. Portal stores a 32-byte
// opaque token in localStorage on first successful login; presents it on
// every subsequent connect; server rotates it on every use. Token alone
// doesn't grant access — the customer's plan still has to be live.

// Speculative call from portal on mount. Heavily rate-limited per IP since
// it's the obvious target for token enumeration.
const autoReconnectLimit = rateLimit({ name: 'autoreconnect', windowMs: 60_000, max: 30 });
api.post('/hotspot/auto-reconnect', autoReconnectLimit, ah(async (req, res) => {
  const body = parse(z.object({
    token: z.string().min(20),
    mac: z.string().min(11),
    fingerprint: z.string().min(16).max(128).optional(),
  }), req.body);
  res.json(await deviceTokens.tryAutoReconnect({
    rawToken: body.token,
    newMac: body.mac,
    fingerprintHash: body.fingerprint ?? null,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }));
}));

// NOTE: The standalone POST /hotspot/issue-token endpoint was removed
// (security review, sprint 2.5 follow-up). It accepted a MAC from the
// request body and bound a token to whatever phone that MAC was tied
// to — letting any LAN attacker who sniffed a victim's MAC mint a
// token for the victim's phone and ride their plan via auto-reconnect.
// Token issuance is now inline in the only three authenticated paths:
//   * /hotspot/pay/:id status flip to 'success' (M-Pesa PIN proves ownership)
//   * /hotspot/rebind/verify (SMS-OTP proves ownership)
//   * admin-driven flows
// Vouchers don't mint tokens since they have no associated phone.

// Fingerprint-based reconnect — third tier when MAC lookup AND token
// lookup both miss. Server correlates the presented browser fingerprint
// against device_tokens.fingerprint_hash; if EXACTLY ONE phone matches
// and that phone has a live active_devices grant, we copy the grant onto
// the presented MAC and mint a fresh token. Ambiguous matches refuse
// rather than guess. Rate-limited to keep enumeration cheap.
const fingerprintReconnectLimit = rateLimit({ name: 'fp_reconnect', windowMs: 60_000, max: 30 });
api.post('/hotspot/fingerprint-reconnect', fingerprintReconnectLimit, ah(async (req, res) => {
  const body = parse(z.object({
    fingerprint: z.string().min(32).max(128),
    mac: z.string().min(11),
  }), req.body);
  res.json(await deviceTokens.tryFingerprintReconnect({
    fingerprintHash: body.fingerprint,
    newMac: body.mac,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }));
}));

// "Forget this device" — customer-driven token revoke.
api.post('/hotspot/forget-device', ah(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20) }), req.body);
  res.json(await deviceTokens.forgetDevice(body.token, 'user_revoked'));
}));

// Admin observability for the auto-reconnect pipeline.
api.get('/admin/auto-reconnect-log', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const phone = typeof req.query.phone === 'string' ? req.query.phone : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await deviceTokens.listRecent(limit, phone));
}));
api.get('/admin/auto-reconnect-stats', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const hours = req.query.hours ? Number(req.query.hours) : 24;
  res.json(await deviceTokens.recentStats(hours));
}));
api.post('/admin/auto-reconnect/forget-phone', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(7) }), req.body);
  const n = await deviceTokens.forgetAllForPhone(body.phone, 'admin_revoked');
  res.json({ revoked: n });
}));

// ---------------------- DPA-Kenya §40 self-service erasure ----------------------
// Two-step SMS-OTP gate. Customer enters phone, gets a 6-digit code, then
// posts it back to confirm. On verify we wipe device_tokens, active_devices,
// and PII columns of auto_reconnect_log / hotspot_purchases / hotspot_rebind_otps
// for that phone (sentinel-replacement preserves NOT NULL aggregate rows
// without leaving an identifying value).
const eraseStartLimit = rateLimit({ name: 'erase_start', windowMs: 60_000, max: 5 });
api.post('/hotspot/erase-me/start', eraseStartLimit, ah(async (req, res) => {
  const body = parse(z.object({ phone: z.string().min(7) }), req.body);
  res.json(await deviceTokens.eraseStart({
    phone: body.phone,
    sourceIp: req.ip,
    userAgent: req.headers['user-agent'],
  }));
}));
const eraseVerifyLimit = rateLimit({ name: 'erase_vrf', windowMs: 60_000, max: 10 });
api.post('/hotspot/erase-me/verify', eraseVerifyLimit, ah(async (req, res) => {
  const body = parse(z.object({
    otpId: z.string().uuid(),
    code: z.string().min(4).max(8),
  }), req.body);
  res.json(await deviceTokens.eraseVerify(body));
}));

// ---------------------- Payment events queue (admin) ----------------------
// Visibility + recovery for the async payment_events worker.
api.get('/admin/payment-events', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status as any : undefined;
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(await paymentEvents.listEvents({ status, source, limit }));
}));
api.get('/admin/payment-events/health', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await paymentEvents.queueHealth());
}));
api.post('/admin/payment-events/:id/retry', requireAuth('admin'), ah(async (req, res) => {
  const row = await paymentEvents.retryEvent(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
}));

// Daraja callback for hotspot purchases. Enqueue-only — the worker calls
// hotspot.handleDarajaCallback asynchronously so radcheck/RADIUS writes
// can fail and retry without losing the ACK to Daraja (which never
// redelivers a callback that timed out the HTTP response).
api.post('/hotspot/mpesa/callback', ah(async (req, res) => {
  const daraja = parseCallback(req.body);
  // If parse fails we still enqueue under a synthetic dedup key so the row
  // shows up in the admin DLQ for diagnosis rather than being silently dropped.
  const dedup = daraja?.checkoutRequestId ?? `unparseable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await paymentEvents.enqueue('mpesa_hotspot', dedup, req.body);
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

// Simulation-only: when M-Pesa creds aren't configured, the portal calls
// this to mark a fake purchase successful. Routed through the same queue
// as real callbacks so the worker path is exercised end-to-end in dev.
api.post('/hotspot/pay/:checkoutRequestId/confirm-test', ah(async (req, res) => {
  // DEV-ONLY: this marks a purchase paid with no money. Hard-gate behind the
  // same flag as simulation so it can never grant free access in production.
  if (process.env.HOTSPOT_SIMULATION !== 'true') {
    return res.status(403).json({ error: 'simulation disabled' });
  }
  await paymentEvents.enqueue(
    'manual_hotspot',
    req.params.checkoutRequestId,
    { checkoutRequestId: req.params.checkoutRequestId }
  );
  // Return immediately — the portal polls /hotspot/pay/:id for status,
  // which will flip to 'success' as soon as the worker drains the job.
  res.json(await hotspot.getPurchaseStatus(req.params.checkoutRequestId));
}));

async function listHotspotPlansInline() {
  const r = await (await import('../db/pool.js')).query<{
    id: string; name: string; price_cents: number; validity_days: number;
    validity_minutes: number | null; data_cap_mb: number | null;
    speed_down_kbps: number | null; speed_up_kbps: number | null;
  }>(
    `SELECT id, name, price_cents, validity_days, validity_minutes, data_cap_mb,
            speed_down_kbps, speed_up_kbps
       FROM plans WHERE type='hotspot' AND active=TRUE
       ORDER BY price_cents ASC`
  );
  return r.rows;
}

// ---------------------- RADIUS sessions ----------------------
api.get('/radius/sessions/active', ah(async (_req, res) => {
  res.json(await radius.listActiveSessions());
}));
api.get('/radius/sessions/recent', ah(async (_req, res) => {
  res.json(await radius.listRecentSessions(50));
}));

// Zero-touch provisioning: generates WG keypair + RouterOS .rsc script + one-liner.
api.post('/routers/provision', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1),
    site: z.string().optional(),
  }), req.body);
  // Point the MikroTik at THIS tenant's host so the provision-token fetch
  // resolves to the tenant that owns it (a global host 404s for isolated tenants).
  res.status(201).json(await routers.provisionRouter({ ...body, baseUrl: `https://${req.hostname}` }));
}));

// Public single-use fetch endpoint: MikroTik calls this via `/tool fetch` and
// receives the RouterOS script as text/plain. Token is consumed on first call.
api.get('/provision/:token', ah(async (req, res) => {
  const script = await routers.fetchProvisionScript(req.params.token, `https://${req.hostname}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(script);
}));
// Push an arbitrary RouterOS command to a router via the WG tunnel + SSH.
// Used by the "Test connection" button and by future subscriber-push features.
api.post('/routers/:id/exec', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({ command: z.string().min(1) }), req.body);
  res.json(await routers.execOnRouter(req.params.id, body.command));
}));

// Re-issue token, rotate RADIUS secret, and SSH-push the new config to the
// MikroTik. If SSH push works, MikroTik self-applies — true one-touch refresh.
api.post('/routers/:id/reprovision', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await routers.reprovisionRouter(req.params.id, `https://${req.hostname}`));
}));

// Build a RouterOS script that turns a LAN interface into a JTM hotspot.
// Detect router model + interfaces over the tunnel. Powers the wizard's
// port-selection step so the admin doesn't have to type interface names.
api.get('/routers/:id/detect', requireAuth('admin', 'staff'), ah(async (req, res) => {
  res.json(await routers.detectRouter(req.params.id));
}));
// Apply selected services (pppoe + hotspot) via SSH push. One-shot.
api.post('/routers/:id/configure', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    services: z.array(z.enum(['pppoe', 'hotspot'])).min(1),
    ports: z.array(z.string()).min(1),
    hotspotNetwork: z.string().optional(),
  }), req.body);
  res.json(await routers.configureServices(req.params.id, body));
}));
api.post('/routers/:id/hotspot-script', requireAuth('admin', 'staff'), ah(async (req, res) => {
  const body = parse(z.object({
    interfaceName: z.string().min(1),
    networkCidr: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/),
  }), req.body);
  res.json(await routers.buildHotspotScript(req.params.id, body));
}));

// Captive portal landing page that MikroTik serves to unauthenticated clients.
// Public — MikroTik fetches each of the 8 hotspot UI files from here during
// provisioning. Each template MikroTik-substitutes $(varname) tokens then
// JS-redirects the client browser to our Next.js portal at /hotspot. See
// domains/hotspot/templates.ts for the per-file content.
api.get('/hotspot/templates/:name', ah(async (req, res) => {
  const slug = typeof req.query.slug === 'string' ? req.query.slug : '';
  // The MikroTik fetches templates from the tenant's own host, so req.hostname
  // IS that host — bake it into the portal redirect URL the customer follows,
  // so customers see the ISP's domain rather than the platform's.
  const tpl = getHotspotTemplate(req.params.name, slug, req.hostname);
  if (!tpl) {
    res.status(404).type('text/plain').send('unknown template');
    return;
  }
  res.setHeader('Content-Type', tpl.contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.send(tpl.body);
}));
// Back-compat: routers provisioned before the bundle existed fetch
// /api/hotspot/login.html. Serve the new login template at that path too.
api.get('/hotspot/login.html', ah(async (_req, res) => {
  const tpl = getHotspotTemplate('login.html', '');
  res.setHeader('Content-Type', tpl!.contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.send(tpl!.body);
}));

// Public — captive portal page calls this to theme itself per venue.
// Slug = router's brand_slug or UUID. Unknown slug returns default HUB.
api.get('/hotspot/branding/:slug', ah(async (req, res) => {
  res.json(await hotspot.getBranding(req.params.slug));
}));

// Public — captive portal calls this on mount when no per-router slug
// is in the URL. Returns the global default (Settings → Hotspot Template).
api.get('/hotspot/branding', ah(async (_req, res) => {
  res.json(await hotspot.getBranding(''));
}));

// Admin — manage the global hotspot branding (logo, ISP name, tagline, color).
api.get('/admin/hotspot-branding', requireAuth('admin', 'staff'), ah(async (_req, res) => {
  res.json(await hotspot.getGlobalBrandingAdmin());
}));
api.put('/admin/hotspot-branding', requireAuth('admin'), ah(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1).max(80).optional(),
    color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    tagline: z.string().max(120).optional(),
    // logoUrl: null clears, undefined leaves alone, data: URL sets.
    logoUrl: z.string().max(280_000).nullable().optional(),
    template: z.enum(['classic', 'aurora', 'minimal', 'sunset']).optional(),
  }), req.body);
  res.json(await hotspot.setGlobalBranding(body));
}));

// Public — Quick Connect: phone-based active-session lookup. Connects the
// caller's MAC if their phone has a live grant on any device. Rate-limited
// per IP since trusting a phone number alone is a soft auth boundary.
const quickConnectLimit = rateLimit({ name: 'quick_connect', windowMs: 60_000, max: 20 });
api.post('/hotspot/quick-connect', quickConnectLimit, ah(async (req, res) => {
  const body = parse(z.object({
    phone: z.string().min(7),
    mac: z.string().min(11),
  }), req.body);
  res.json(await hotspotDevices.quickConnect({
    phone: body.phone,
    mac: body.mac,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }));
}));

// Identify: called by the MikroTik itself (no auth — gated by the unguessable
// provisioning token) to report its serial number. API uses this to merge
// duplicate router rows that point at the same physical box.
api.post('/routers/identify', ah(async (req, res) => {
  // Body comes from MikroTik /tool fetch as application/x-www-form-urlencoded
  // OR as raw text; accept both shapes.
  const raw = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const parsed = typeof raw === 'string'
    ? Object.fromEntries(new URLSearchParams(raw))
    : raw;
  const body = parse(z.object({
    token: z.string().min(1),
    serial: z.string().min(1),
    sshPort: z.coerce.number().int().min(1).max(65535).optional(),
  }), parsed);
  res.json(await routers.identifyRouter(body.token, body.serial, body.sshPort));
}));

// Remove a router row + its WG peer on VPS + its nas row. Use for stale
// orphan records (e.g. test routers that were provisioned but never used).
api.delete('/routers/:id', requireAuth('admin', 'staff'), ah(async (req, res) => {
  await routers.deleteRouter(req.params.id);
  res.status(204).end();
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
