/**
 * Notification Service — SMS / WhatsApp / Telegram / Email.
 *
 * SMS (Africa's Talking) and WhatsApp (Meta Cloud API) go live when their
 * credentials are configured; otherwise — and for Telegram/Email — the channel
 * logs. Drop in a Telegram bot and SendGrid/SES the same way to finish. The
 * call sites (triggered by domain events) never change.
 */

import { config } from '../../config.js';
import { sendSms } from './africastalking.js';
import { sendBytwaveSms } from './bytwave.js';
import { sendWhatsApp, sendWhatsAppTemplate } from './whatsapp.js';
import { sendTelegram } from './telegram.js';
import { sendEmail } from './email.js';

type Channel = 'sms' | 'whatsapp' | 'telegram' | 'email';

/**
 * For the email channel, a message may carry its subject as the first line
 * ("Subject\nBody"); otherwise a default subject is used.
 */
function splitSubject(message: string): { subject: string; body: string } {
  const nl = message.indexOf('\n');
  if (nl > 0 && nl <= 120) {
    return { subject: message.slice(0, nl).trim(), body: message.slice(nl + 1).trim() };
  }
  return { subject: 'JTM Networks', body: message };
}

/**
 * Send a pre-approved WhatsApp template — the only message type Meta allows to
 * initiate a conversation outside the 24h customer-care window. Falls back to
 * logging when WhatsApp is in simulation mode. Never throws.
 */
export async function notifyTemplate(
  to: string,
  templateName: string,
  bodyParams: string[] = [],
  langCode = 'en'
): Promise<void> {
  if (!config.whatsapp.simulated) {
    try {
      const r = await sendWhatsAppTemplate(to, templateName, bodyParams, langCode);
      console.log(`[notify:wa-template->meta] ${to} (${templateName}): ${r.ok ? r.detail : 'FAILED ' + r.detail}`);
    } catch (err) {
      console.error(`[notify:wa-template->meta] failed for ${to}:`, err);
    }
    return;
  }
  console.log(`[notify:wa-template] -> ${to}: ${templateName}(${bodyParams.join(', ')})`);
}

export async function notify(
  channel: Channel,
  to: string,
  message: string
): Promise<void> {
  // Failures never throw — a notification must not break the business flow
  // that triggered it.
  if (channel === 'sms' && !config.sms.simulated) {
    // Dispatch to the configured provider. Failure logged; never thrown
    // (the calling business flow must not break because the SMS gateway
    // had a moment).
    try {
      const r = config.sms.provider === 'bytwave'
        ? await sendBytwaveSms(to, message)
        : await sendSms(to, message);
      console.log(`[notify:sms->${config.sms.provider}] ${to}: ${r.ok ? r.detail : 'FAILED ' + r.detail}`);
    } catch (err) {
      console.error(`[notify:sms->${config.sms.provider}] failed for ${to}:`, err);
    }
    return;
  }
  if (channel === 'whatsapp' && !config.whatsapp.simulated) {
    try {
      const r = await sendWhatsApp(to, message);
      console.log(`[notify:whatsapp->meta] ${to}: ${r.ok ? r.detail : 'FAILED ' + r.detail}`);
    } catch (err) {
      console.error(`[notify:whatsapp->meta] failed for ${to}:`, err);
    }
    return;
  }
  if (channel === 'email' && !config.email.simulated) {
    const { subject, body } = splitSubject(message);
    try {
      const r = await sendEmail(to, subject, body);
      console.log(`[notify:email->sendgrid] ${to}: ${r.ok ? r.detail : 'FAILED ' + r.detail}`);
    } catch (err) {
      console.error(`[notify:email->sendgrid] failed for ${to}:`, err);
    }
    return;
  }
  if (channel === 'telegram' && !config.telegram.simulated) {
    // Admin alerts go to the first configured admin chat (or the given id).
    const chat = to && to !== 'telegram-admin' ? to : config.telegram.adminChatIds[0];
    try {
      if (chat) {
        const r = await sendTelegram(chat, message);
        console.log(`[notify:telegram->bot] ${chat}: ${r.ok ? r.detail : 'FAILED ' + r.detail}`);
      }
    } catch (err) {
      console.error(`[notify:telegram->bot] failed:`, err);
    }
    return;
  }
  console.log(`[notify:${channel}] -> ${to}: ${message}`);
}

export const notifications = {
  sms: (to: string, msg: string) => notify('sms', to, msg),
  whatsapp: (to: string, msg: string) => notify('whatsapp', to, msg),
  whatsappTemplate: (to: string, template: string, params: string[] = [], lang = 'en') =>
    notifyTemplate(to, template, params, lang),
  telegram: (to: string, msg: string) => notify('telegram', to, msg),
  email: (to: string, msg: string) => notify('email', to, msg),
};
