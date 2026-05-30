'use client';
import { useEffect, useState } from 'react';

// Customer-portal UI strings in English + Swahili.
export type Lang = 'en' | 'sw';

const strings: Record<string, { en: string; sw: string }> = {
  portal_title: { en: 'Customer Portal', sw: 'Tovuti ya Mteja' },
  portal_sub: { en: 'Self-service: check your balance & usage, redeem a voucher, or top up via M-Pesa.', sw: 'Huduma binafsi: angalia salio na matumizi, tumia vocha, au ongeza salio kupitia M-Pesa.' },
  phone_label: { en: 'Your phone number', sw: 'Namba yako ya simu' },
  lookup: { en: 'Look up', sw: 'Tafuta' },
  account: { en: 'Account', sw: 'Akaunti' },
  wallet_balance: { en: 'Wallet balance', sw: 'Salio la pochi' },
  mpesa_topup: { en: 'M-Pesa top-up', sw: 'Ongeza kwa M-Pesa' },
  data_used: { en: 'Data used', sw: 'Data iliyotumika' },
  kyc_title: { en: 'Verify your identity (KYC)', sw: 'Thibitisha utambulisho wako (KYC)' },
  doc_type: { en: 'Document type', sw: 'Aina ya hati' },
  file: { en: 'File', sw: 'Faili' },
  active_subs: { en: 'Active subscriptions', sw: 'Vifurushi vinavyotumika' },
  change_plan: { en: 'Change plan (prorated)', sw: 'Badilisha kifurushi (kwa uwiano)' },
  switch_to: { en: 'Switch to', sw: 'Badilisha kwenda' },
  change_plan_btn: { en: 'Change plan', sw: 'Badilisha kifurushi' },
  buy_plan: { en: 'Buy a plan', sw: 'Nunua kifurushi' },
  plan: { en: 'Plan', sw: 'Kifurushi' },
  gift_to: { en: 'Gift to phone (optional)', sw: 'Zawadi kwa nambari (hiari)' },
  pay_wallet: { en: 'Pay from wallet', sw: 'Lipa kutoka pochi' },
  redeem_voucher: { en: 'Redeem a voucher', sw: 'Tumia vocha' },
  voucher_code: { en: 'Voucher code', sw: 'Msimbo wa vocha' },
  redeem: { en: 'Redeem', sw: 'Tumia' },
  no_plan: { en: 'No active plan', sw: 'Hakuna kifurushi kinachotumika' },
  select_plan: { en: 'Select plan…', sw: 'Chagua kifurushi…' },
};

export function tr(lang: Lang, key: keyof typeof strings): string {
  return strings[key]?.[lang] ?? strings[key]?.en ?? String(key);
}

/** Persisted language preference hook (localStorage). */
export function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? (window.localStorage.getItem('jtm_lang') as Lang | null) : null;
    if (saved === 'en' || saved === 'sw') setLangState(saved);
  }, []);
  const setLang = (l: Lang) => {
    setLangState(l);
    if (typeof window !== 'undefined') window.localStorage.setItem('jtm_lang', l);
  };
  return [lang, setLang];
}
