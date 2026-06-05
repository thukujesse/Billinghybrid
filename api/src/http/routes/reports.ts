/**
 * Reports routes — unified revenue across legacy `payments` and modern
 * `hotspot_purchases`, PPPoE MRR, outstanding renewals, CSV exports.
 *
 * The legacy /reports/revenue, /reports/top-plans, /reports/churn,
 * /reports/payments.csv endpoints stay in routes.ts for now — they
 * pre-existed and aren't part of this sprint's overhaul.
 */
import { Router } from 'express';
import { ah } from '../helpers.js';
import { requireAuth } from '../middleware/auth.js';
import * as reports from '../../domains/reports/service.js';

export function registerReportsRoutes(api: Router): void {
  api.get('/reports/revenue-combined', ah(async (req, res) => {
    const months = req.query.months ? Math.min(Number(req.query.months), 36) : 12;
    res.json(await reports.revenueByMonthCombined(months));
  }));
  api.get('/reports/revenue-by-plan', ah(async (req, res) => {
    const days = req.query.days ? Math.min(Number(req.query.days), 365) : 30;
    res.json(await reports.revenueByPlan(days));
  }));
  api.get('/reports/outstanding-renewals', ah(async (_req, res) => {
    res.json(await reports.outstandingRenewals());
  }));
  api.get('/reports/pppoe-mrr', ah(async (_req, res) => {
    res.json(await reports.pppoeMrr());
  }));
  api.get('/reports/customers.csv', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    const csv = await reports.customersCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
    res.send(csv);
  }));
  api.get('/reports/hotspot-purchases.csv', requireAuth('admin', 'staff'), ah(async (_req, res) => {
    const csv = await reports.hotspotPurchasesCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="hotspot-purchases.csv"');
    res.send(csv);
  }));
}
