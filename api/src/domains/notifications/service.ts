/**
 * Notification Service — SMS / WhatsApp / Telegram / Email.
 *
 * Channels are stubbed (logged) so the event-driven flows are fully wired and
 * testable without provider credentials. Drop in Africa's Talking, WhatsApp
 * Business API, a Telegram bot, and SendGrid/SES to go live — the call sites
 * (triggered by domain events) stay the same.
 */

import { config } from '../../config.js';
import { sendSms } from './africastalking.js';

type Channel = 'sms' | 'whatsapp' | 'telegram' | 'email';

export async function notify(
  channel: Channel,
  to: string,
  message: string
): Promise<void> {
  // SMS goes live through Africa's Talking when credentials are set; every
  // other channel (and SMS without creds) logs. Failures never throw — a
  // notification must not break the business flow that triggered it.
  if (channel === 'sms' && !config.sms.simulated) {
    try {
      const r = await sendSms(to, message);
      console.log(`[notify:sms->AT] ${to}: ${r.detail}`);
      return;
    } catch (err) {
      console.error(`[notify:sms->AT] failed for ${to}:`, err);
      return;
    }
  }
  console.log(`[notify:${channel}] -> ${to}: ${message}`);
}

export const notifications = {
  sms: (to: string, msg: string) => notify('sms', to, msg),
  whatsapp: (to: string, msg: string) => notify('whatsapp', to, msg),
  telegram: (to: string, msg: string) => notify('telegram', to, msg),
  email: (to: string, msg: string) => notify('email', to, msg),
};
