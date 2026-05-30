/**
 * Tiny i18n for outbound notification copy. Swahili (sw) + English (en).
 * Messages are keyed; `t()` interpolates {placeholders}. Unknown keys/locales
 * fall back to English, then to the raw key — so a missing translation never
 * blocks a notification.
 */

export type Lang = 'en' | 'sw';

type Dict = Record<string, string>;

const en: Dict = {
  'payment.received': 'Payment received. Thank you!',
  'voucher.active': 'Your voucher is active. Enjoy your connection!',
  'invoice.dunning': 'Payment for invoice {invoice} failed (attempt {attempt}). Please top up.',
  'subscriber.suspended': 'Your service has been suspended ({reason}). Please clear your balance to restore.',
  'subscriber.restored': 'Welcome back! Your service has been restored.',
  'fup.threshold': "You've used {pct}% of your data. Top up to avoid throttling.",
  'fup.exceeded': 'Data cap reached — speed is now reduced. Top up to restore full speed.',
  'plan.gift.received': "You've received a gift plan — it's now active. Enjoy!",
  'plan.gift.sent': 'Your gift plan was delivered successfully.',
  'plan.active': 'Your plan is active. Thank you!',
  'plan.changed': 'Your plan has been {verb}. It takes effect immediately.',
  'credit.added': 'A credit has been added to your account.',
  'refund.processed': 'A refund of {amount} ({method}) has been processed.',
  'kyc.reviewed': 'Your KYC has been {decision}.',
  'otp.code': 'Your login code is {code}. It expires in {minutes} minutes.',
};

const sw: Dict = {
  'payment.received': 'Malipo yamepokelewa. Asante!',
  'voucher.active': 'Vocha yako imeanzishwa. Furahia muunganisho wako!',
  'invoice.dunning': 'Malipo ya ankara {invoice} yameshindwa (jaribio {attempt}). Tafadhali ongeza salio.',
  'subscriber.suspended': 'Huduma yako imesimamishwa ({reason}). Tafadhali lipa salio lako ili kurejesha.',
  'subscriber.restored': 'Karibu tena! Huduma yako imerejeshwa.',
  'fup.threshold': 'Umetumia asilimia {pct} ya data yako. Ongeza salio ili kuepuka kupunguzwa kasi.',
  'fup.exceeded': 'Kikomo cha data kimefikiwa — kasi imepunguzwa. Ongeza salio ili kurejesha kasi kamili.',
  'plan.gift.received': 'Umepokea kifurushi cha zawadi — kimeanzishwa. Furahia!',
  'plan.gift.sent': 'Kifurushi chako cha zawadi kimewasilishwa.',
  'plan.active': 'Kifurushi chako kimeanzishwa. Asante!',
  'plan.changed': 'Kifurushi chako kimebadilishwa ({verb}). Kinaanza mara moja.',
  'credit.added': 'Salio limeongezwa kwenye akaunti yako.',
  'refund.processed': 'Marejesho ya {amount} ({method}) yamefanyika.',
  'kyc.reviewed': 'KYC yako ime{decision}.',
  'otp.code': 'Msimbo wako wa kuingia ni {code}. Unaisha baada ya dakika {minutes}.',
};

const dicts: Record<Lang, Dict> = { en, sw };

export function t(lang: Lang | string | null | undefined, key: string, vars: Record<string, unknown> = {}): string {
  const l: Lang = lang === 'sw' ? 'sw' : 'en';
  const template = dicts[l][key] ?? en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}
