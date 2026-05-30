import { on } from './bus.js';
import {
  paymentsTotal,
  vouchersRedeemed,
  invoicesCreated,
  subscribersSuspended,
  fupThrottled,
} from '../../lib/metrics.js';

/**
 * Maps domain events to business metrics. Decoupled from the notification
 * handlers — adding observability never touches business logic.
 */

on('payment.paid', () => paymentsTotal.inc({ provider: 'any', status: 'success' }));
on('payment.failed', () => paymentsTotal.inc({ provider: 'any', status: 'failed' }));
on('voucher.redeemed', () => vouchersRedeemed.inc());
on('invoice.created', () => invoicesCreated.inc());
on('subscriber.suspended', () => subscribersSuspended.inc());
on('usage.fup.exceeded', () => fupThrottled.inc());
