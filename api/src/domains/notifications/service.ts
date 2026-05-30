/**
 * Notification Service — SMS / WhatsApp / Telegram / Email.
 *
 * Channels are stubbed (logged) so the event-driven flows are fully wired and
 * testable without provider credentials. Drop in Africa's Talking, WhatsApp
 * Business API, a Telegram bot, and SendGrid/SES to go live — the call sites
 * (triggered by domain events) stay the same.
 */

type Channel = 'sms' | 'whatsapp' | 'telegram' | 'email';

export async function notify(
  channel: Channel,
  to: string,
  message: string
): Promise<void> {
  console.log(`[notify:${channel}] -> ${to}: ${message}`);
}

export const notifications = {
  sms: (to: string, msg: string) => notify('sms', to, msg),
  whatsapp: (to: string, msg: string) => notify('whatsapp', to, msg),
  telegram: (to: string, msg: string) => notify('telegram', to, msg),
  email: (to: string, msg: string) => notify('email', to, msg),
};
