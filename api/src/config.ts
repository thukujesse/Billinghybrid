import 'dotenv/config';

function num(name: string, def: number): number {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 4000),
  // Public URL this API is reachable at. Used to build the MikroTik one-liner
  // (`/tool fetch url=...`). Render sets RENDER_EXTERNAL_URL automatically.
  publicApiUrl:
    process.env.PUBLIC_API_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    'http://localhost:4000',
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
    // Which provider to dispatch SMS through. Default is 'bytwave' since
    // Bytewave Networks is the active shared-tenant provider; flip to
    // 'africastalking' via SMS_PROVIDER env var or the /settings UI.
    provider: (process.env.SMS_PROVIDER ?? 'bytwave') as 'africastalking' | 'bytwave',
    // Africa's Talking creds.
    username: process.env.AT_USERNAME ?? 'sandbox',
    apiKey: process.env.AT_API_KEY ?? '',
    senderId: process.env.AT_SENDER_ID ?? '',
    // Bytwave (Bytewave Networks) creds. Multi-tenant is on the roadmap —
    // for now these are the single shared-tenant defaults. DB settings
    // (sms.bytwave.* keys) override these at runtime.
    //
    // SECURITY NOTE: hardcoding the API token here puts it in the git
    // repo. Acceptable for a private-repo MVP, NOT for a public repo or
    // after multi-tenant ships. When multi-tenant lands:
    //   1) rotate this token in the Bytewave portal
    //   2) store per-tenant tokens in a tenants table
    //   3) blank the default below back to ''
    bytwave: {
      apiKey: process.env.BYTWAVE_API_KEY
        ?? '347|7QuqqfS6anwTyGNm32nt5McOCqcBqAjqjGqtnI6bfb239a36',
      // Bytewave Networks' HTTP-API base. The actual SMS-send path under
      // it varies by version of their docs — try /messages first, fall
      // back via /settings UI override if 404.
      endpoint: process.env.BYTWAVE_ENDPOINT
        ?? 'https://portal.bytewavenetworks.com/api/http/sms/send',
      senderId: process.env.BYTWAVE_SENDER_ID ?? 'HUBNET',
      payloadFormat: (process.env.BYTWAVE_PAYLOAD_FORMAT ?? 'json') as 'json' | 'form',
    },
    // Without credentials for the SELECTED provider, SMS is logged rather
    // than sent. This avoids dropping messages when only the OTHER
    // provider is configured.
    get simulated() {
      if (this.provider === 'bytwave') return !this.bytwave.apiKey;
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
  paymentQueue: {
    // Worker loop runs inside the API process unless WORKER_ENABLED=false
    // (useful for read-only replicas / scratch deploys).
    enabled: (process.env.WORKER_ENABLED ?? 'true') !== 'false',
    intervalMs: num('PAYMENT_WORKER_INTERVAL_MS', 2000),
    batchSize: num('PAYMENT_WORKER_BATCH_SIZE', 10),
    maxAttempts: num('PAYMENT_WORKER_MAX_ATTEMPTS', 5),
    // Rows still in 'processing' after this long are considered crashed
    // and re-queued by the stale-lock reaper.
    staleLockMs: num('PAYMENT_WORKER_STALE_LOCK_MS', 300_000),
    // Notification channel for DLQ alerts. Empty = log only.
    dlqAlertChannel: (process.env.PAYMENT_DLQ_ALERT_CHANNEL ?? 'telegram') as 'telegram' | 'email' | 'sms' | '',
    dlqAlertTo: process.env.PAYMENT_DLQ_ALERT_TO ?? '',
  },
  portal: {
    // Public hostname for the customer-facing captive portal (hotspot + renew).
    // VPS Caddy reverse-proxies this to jtm-web and jtm-api. MikroTik
    // walled-garden allows ONLY this host/IP — Render's edge IPs rotate, the
    // VPS IP is stable, so the captive never silently breaks.
    host: process.env.PORTAL_HOST ?? 'billing.hubnetwifi.co.ke',
    // Stable VPS IP the portal hostname resolves to. Used as the dst-address
    // in walled-garden rules on RouterOS versions older than 7.7 (where
    // tls-host isn't supported).
    ip: process.env.PORTAL_IP ?? '38.60.134.212',
  },
  wireguard: {
    // Public key of the VPS WG server. MikroTik peers trust this in their
    // peer config. Empty = provisioning endpoint refuses to issue scripts.
    serverPublicKey: process.env.WG_SERVER_PUBKEY ?? '',
    // Hostname + UDP port MikroTiks dial to reach the VPS WG server.
    // Port 4500 (IPSec NAT-T) is rarely blocked by ISPs; 51820 (WG default)
    // is filtered by some carriers, so we default to the safer one.
    endpoint: process.env.WG_ENDPOINT ?? 'vpn.hubnetwifi.co.ke:4500',
    // Tunnel network (CIDR). Server lives at .1, .2 reserved, peers from .3.
    // /16 = 65k peers headroom. Picked .66 to avoid 10.0/10.10/10.100 conflicts.
    network: process.env.WG_NETWORK ?? '10.66.0.0/16',
    // VPS wg-manager: small service on the VPS that this API calls to add or
    // remove peers on wg0. Empty managerToken => provisioning falls back to
    // returning the manual `wg set` command (slice 1 behavior).
    managerUrl: process.env.WG_MANAGER_URL ?? 'https://vpn.hubnetwifi.co.ke/wg',
    managerToken: process.env.WG_MANAGER_TOKEN ?? '',
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
