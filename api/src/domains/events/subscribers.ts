import { on } from './bus.js';
import { config } from '../../config.js';
import { notifications } from '../notifications/service.js';
import { languageOf } from '../subscribers/service.js';
import { t } from '../../lib/i18n.js';

/**
 * Cross-cutting reactions to domain events. This is where the data-flow
 * diagrams' "→ Notification" / "→ Telegram admin alert" steps live. Adding a
 * new reaction means subscribing here, with no change to the publisher.
 *
 * Customer-facing copy is localized to the subscriber's language (en/sw) via
 * t(); admin alerts stay in English.
 */

const ADMIN_CHANNEL = 'telegram-admin';

on('payment.paid', async (p) => {
  const id = String(p.subscriberId ?? '');
  const lang = id ? await languageOf(id) : 'en';
  // A receipt is typically business-initiated (sent after payment, outside the
  // 24h window), so use a pre-approved template. The "payment_receipt" template
  // is expected to take one body param: the amount. Falls back to a log in
  // simulation mode.
  const amountKes = (Number(p.amount ?? 0) / 100).toFixed(2);
  await notifications.whatsappTemplate(id || 'customer', config.whatsapp.receiptTemplate, [`KES ${amountKes}`], lang);
});

on('voucher.redeemed', async (p) => {
  const id = String(p.subscriberId);
  await notifications.sms(id, t(await languageOf(id), 'voucher.active'));
});

on('invoice.dunning', async (p) => {
  const id = String(p.subscriberId ?? '');
  const lang = id ? await languageOf(id) : 'en';
  await notifications.whatsapp(id || 'customer', t(lang, 'invoice.dunning', { invoice: p.invoiceId, attempt: p.attempt }));
});

on('subscriber.suspended', async (p) => {
  const id = String(p.subscriberId);
  await notifications.sms(id, t(await languageOf(id), 'subscriber.suspended', { reason: p.reason }));
  await notifications.telegram(ADMIN_CHANNEL, `Subscriber ${id} suspended: ${p.reason}`);
});

on('subscriber.restored', async (p) => {
  const id = String(p.subscriberId);
  await notifications.sms(id, t(await languageOf(id), 'subscriber.restored'));
});

on('usage.fup.threshold', async (p) => {
  const id = String(p.subscriberId);
  await notifications.whatsapp(id, t(await languageOf(id), 'fup.threshold', { pct: p.usedPct }));
});

on('usage.fup.exceeded', async (p) => {
  const id = String(p.subscriberId);
  await notifications.sms(id, t(await languageOf(id), 'fup.exceeded'));
});

on('plan.purchased', async (p) => {
  if (p.gifted) {
    const rid = String(p.recipientId);
    const bid = String(p.buyerId);
    await notifications.sms(rid, t(await languageOf(rid), 'plan.gift.received'));
    await notifications.whatsapp(bid, t(await languageOf(bid), 'plan.gift.sent'));
  } else {
    const bid = String(p.buyerId);
    await notifications.whatsapp(bid, t(await languageOf(bid), 'plan.active'));
  }
});

on('plan.changed', async (p) => {
  const id = String(p.subscriberId);
  const lang = await languageOf(id);
  // Localize the verb too (en: upgraded/downgraded; sw uses a single phrasing).
  const verbEn = p.direction === 'upgrade' ? 'upgraded' : p.direction === 'downgrade' ? 'downgraded' : 'changed';
  const verb = lang === 'sw'
    ? (p.direction === 'upgrade' ? 'kupandishwa' : p.direction === 'downgrade' ? 'kushushwa' : 'badilishwa')
    : verbEn;
  await notifications.sms(id, t(lang, 'plan.changed', { verb }));
});

on('credit_note.issued', async (p) => {
  const id = String(p.subscriberId);
  await notifications.sms(id, t(await languageOf(id), 'credit.added'));
});

on('payment.refunded', async (p) => {
  await notifications.whatsapp('customer', t('en', 'refund.processed', { amount: p.amount, method: p.method }));
});

on('kyc.submitted', async (p) => {
  await notifications.telegram(ADMIN_CHANNEL, `New KYC document submitted by ${p.subscriberId} — review pending.`);
});

on('kyc.reviewed', async (p) => {
  const id = String(p.subscriberId);
  const lang = await languageOf(id);
  const decision = lang === 'sw'
    ? (p.decision === 'verified' ? 'thibitishwa' : 'kataliwa')
    : p.decision;
  await notifications.sms(id, t(lang, 'kyc.reviewed', { decision }));
});
