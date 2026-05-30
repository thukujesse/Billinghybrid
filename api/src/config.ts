import 'dotenv/config';

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 4000),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://jtm:jtm@127.0.0.1:5432/jtm',
  currency: process.env.DEFAULT_CURRENCY ?? 'KES',
  taxRegion: process.env.DEFAULT_TAX_REGION ?? 'KE',
  dunning: {
    maxAttempts: num('DUNNING_MAX_ATTEMPTS', 3),
    graceDays: num('INVOICE_GRACE_DAYS', 5),
  },
  mpesa: {
    env: process.env.MPESA_ENV ?? 'sandbox',
    consumerKey: process.env.MPESA_CONSUMER_KEY ?? '',
    consumerSecret: process.env.MPESA_CONSUMER_SECRET ?? '',
    shortcode: process.env.MPESA_SHORTCODE ?? '174379',
    passkey: process.env.MPESA_PASSKEY ?? '',
    callbackUrl:
      process.env.MPESA_CALLBACK_URL ??
      'http://localhost:4000/api/payments/mpesa/callback',
    // Without credentials the gateway runs in simulation mode.
    get simulated() {
      return !this.consumerKey || !this.consumerSecret;
    },
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    get simulated() {
      return !this.secretKey;
    },
  },
};
