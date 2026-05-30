import { on } from './bus.js';
import { notifications } from '../notifications/service.js';

/**
 * Cross-cutting reactions to domain events. This is where the data-flow
 * diagrams' "→ Notification" / "→ Telegram admin alert" steps live. Adding a
 * new reaction means subscribing here, with no change to the publisher.
 */

const ADMIN_CHANNEL = 'telegram-admin';

on('payment.paid', async (p) => {
  await notifications.whatsapp(String(p.subscriberId ?? 'customer'), `Payment received. Thank you!`);
});

on('voucher.redeemed', async (p) => {
  await notifications.sms(String(p.subscriberId), `Your voucher is active. Enjoy your connection!`);
});

on('invoice.dunning', async (p) => {
  await notifications.whatsapp('customer', `Payment for invoice ${p.invoiceId} failed (attempt ${p.attempt}). Please top up.`);
});

on('subscriber.suspended', async (p) => {
  await notifications.sms(String(p.subscriberId), `Your service has been suspended (${p.reason}). Please clear your balance to restore.`);
  await notifications.telegram(ADMIN_CHANNEL, `Subscriber ${p.subscriberId} suspended: ${p.reason}`);
});

on('subscriber.restored', async (p) => {
  await notifications.sms(String(p.subscriberId), `Welcome back! Your service has been restored.`);
});

on('usage.fup.threshold', async (p) => {
  await notifications.whatsapp(String(p.subscriberId), `You've used ${p.usedPct}% of your data. Top up to avoid throttling.`);
});

on('usage.fup.exceeded', async (p) => {
  await notifications.sms(String(p.subscriberId), `Data cap reached — speed is now reduced. Top up to restore full speed.`);
});

on('plan.purchased', async (p) => {
  if (p.gifted) {
    await notifications.sms(String(p.recipientId), `You've received a gift plan — it's now active. Enjoy!`);
    await notifications.whatsapp(String(p.buyerId), `Your gift plan was delivered successfully.`);
  } else {
    await notifications.whatsapp(String(p.buyerId), `Your plan is active. Thank you!`);
  }
});

on('plan.changed', async (p) => {
  const verb = p.direction === 'upgrade' ? 'upgraded' : p.direction === 'downgrade' ? 'downgraded' : 'changed';
  await notifications.sms(String(p.subscriberId), `Your plan has been ${verb}. It takes effect immediately.`);
});

on('credit_note.issued', async (p) => {
  await notifications.sms(String(p.subscriberId), `A credit has been added to your account.`);
});

on('payment.refunded', async (p) => {
  await notifications.whatsapp('customer', `A refund of ${p.amount} (${p.method}) has been processed.`);
});
