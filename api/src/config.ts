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
  brandName: process.env.BRAND_NAME ?? 'JTM Networks',
  storage: {
    dir: process.env.STORAGE_DIR ?? './storage',
  },
  network: {
    // 'log' (default, safe) or 'mikrotik' (RouterOS command planner)
    driver: process.env.NETWORK_DRIVER ?? 'log',
  },
  auth: {
    // When false, the API runs open (demo mode) and requireAuth injects a
    // synthetic admin. Set AUTH_ENABLED=true to enforce JWT + RBAC.
    enabled: (process.env.AUTH_ENABLED ?? 'false') === 'true',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-secret-change-me',
    jwtTtlHours: num('JWT_TTL_HOURS', 12),
    otpTtlMinutes: num('OTP_TTL_MINUTES', 5),
    otpMaxAttempts: num('OTP_MAX_ATTEMPTS', 5),
  },
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
  sms: {
    username: process.env.AT_USERNAME ?? 'sandbox',
    apiKey: process.env.AT_API_KEY ?? '',
    senderId: process.env.AT_SENDER_ID ?? '',
    // Without an API key, SMS is logged rather than sent.
    get simulated() {
      return !this.apiKey;
    },
  },
  whatsapp: {
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID ?? '',
    accessToken: process.env.WA_ACCESS_TOKEN ?? '',
    // Name of the pre-approved template used for payment receipts.
    receiptTemplate: process.env.WA_RECEIPT_TEMPLATE ?? 'payment_receipt',
    // Without a phone-number id + token, WhatsApp is logged rather than sent.
    get simulated() {
      return !this.phoneNumberId || !this.accessToken;
    },
  },
  email: {
    apiKey: process.env.SENDGRID_API_KEY ?? '',
    from: process.env.EMAIL_FROM ?? 'no-reply@jtm.example',
    // Without an API key, email is logged rather than sent.
    get simulated() {
      return !this.apiKey;
    },
  },
  wireguard: {
    // Public key of the VPS WG server. MikroTik peers trust this in their
    // peer config. Empty = provisioning endpoint refuses to issue scripts.
    serverPublicKey: process.env.WG_SERVER_PUBKEY ?? '',
    // Hostname + UDP port MikroTiks dial to reach the VPS WG server.
    endpoint: process.env.WG_ENDPOINT ?? 'vpn.hubnetwifi.co.ke:51820',
    // Tunnel network (CIDR). Server lives at .1; peers get .3 onwards.
    network: process.env.WG_NETWORK ?? '10.66.66.0/24',
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    // Comma-separated chat ids allowed to issue admin commands.
    adminChatIds: (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Secret path token guarding the webhook endpoint.
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    // Without a bot token, Telegram messages are logged rather than sent.
    get simulated() {
      return !this.botToken;
    },
  },
};
