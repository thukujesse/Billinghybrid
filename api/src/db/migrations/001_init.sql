-- =====================================================================
-- JTM Hybrid ISP Billing — initial schema
-- Money is stored in integer MINOR UNITS (cents) to avoid float errors.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Tax rules (Billing Engine: "Tax on Bills" + per-region VAT)
-- rate_bps = basis points, e.g. 1600 = 16% (Kenya VAT)
-- ---------------------------------------------------------------------
CREATE TABLE tax_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region      TEXT NOT NULL,
  name        TEXT NOT NULL,
  rate_bps    INTEGER NOT NULL CHECK (rate_bps >= 0),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tax_rules_region_active_uidx
  ON tax_rules (region) WHERE active;

-- ---------------------------------------------------------------------
-- Plans / Packages (prepaid, postpaid, hotspot)
-- ---------------------------------------------------------------------
CREATE TABLE plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('prepaid','postpaid','hotspot')),
  price_cents     BIGINT NOT NULL CHECK (price_cents >= 0),
  currency        TEXT NOT NULL DEFAULT 'KES',
  billing_cycle   TEXT NOT NULL DEFAULT 'none'
                    CHECK (billing_cycle IN ('none','daily','weekly','monthly')),
  validity_days   INTEGER NOT NULL DEFAULT 30 CHECK (validity_days > 0),
  data_cap_mb     BIGINT,                 -- NULL = unlimited
  speed_down_kbps INTEGER,
  speed_up_kbps   INTEGER,
  fup_threshold_pct INTEGER NOT NULL DEFAULT 80 CHECK (fup_threshold_pct BETWEEN 1 AND 100),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Resellers / sub-dealers
-- ---------------------------------------------------------------------
CREATE TABLE resellers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  phone          TEXT UNIQUE,
  email          TEXT,
  commission_bps INTEGER NOT NULL DEFAULT 1000 CHECK (commission_bps >= 0), -- 10%
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Subscribers (Hotspot / PPPoE)
-- ---------------------------------------------------------------------
CREATE TABLE subscribers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    TEXT NOT NULL,
  phone        TEXT NOT NULL UNIQUE,
  email        TEXT,
  type         TEXT NOT NULL DEFAULT 'hotspot' CHECK (type IN ('hotspot','pppoe')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','suspended','inactive')),
  kyc_status   TEXT NOT NULL DEFAULT 'none'
                 CHECK (kyc_status IN ('none','pending','verified','rejected')),
  pppoe_username TEXT UNIQUE,
  pppoe_password TEXT,
  reseller_id  UUID REFERENCES resellers(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Subscriptions: a subscriber is on a plan for a window
-- ---------------------------------------------------------------------
CREATE TABLE subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  plan_id       UUID NOT NULL REFERENCES plans(id),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','active','suspended','expired')),
  start_at      TIMESTAMPTZ,
  end_at        TIMESTAMPTZ,
  auto_renew    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_subscriber_idx ON subscriptions (subscriber_id);
CREATE INDEX subscriptions_due_idx ON subscriptions (status, end_at);

-- ---------------------------------------------------------------------
-- Wallets + immutable ledger (User Balance / Wallet with audit trail)
-- owner_type: subscriber | reseller
-- ---------------------------------------------------------------------
CREATE TABLE wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('subscriber','reseller')),
  owner_id      UUID NOT NULL,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'KES',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE ledger_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id          UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_after_cents BIGINT NOT NULL,
  reason             TEXT NOT NULL,
  reference_type     TEXT,
  reference_id       UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_wallet_idx ON ledger_entries (wallet_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Invoices + line items (Billing Engine)
-- ---------------------------------------------------------------------
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number          TEXT NOT NULL UNIQUE,
  subscriber_id   UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('draft','open','paid','void','overdue')),
  subtotal_cents  BIGINT NOT NULL DEFAULT 0,
  tax_cents       BIGINT NOT NULL DEFAULT 0,
  total_cents     BIGINT NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'KES',
  due_date        TIMESTAMPTZ NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ,
  dunning_attempts INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_subscriber_idx ON invoices (subscriber_id);
CREATE INDEX invoices_status_due_idx ON invoices (status, due_date);

CREATE TABLE invoice_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL,
  amount_cents     BIGINT NOT NULL,
  tax_rate_bps     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);

-- ---------------------------------------------------------------------
-- Payments (M-Pesa / Stripe / wallet / manual) — idempotent
-- ---------------------------------------------------------------------
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id   UUID REFERENCES subscribers(id) ON DELETE SET NULL,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('mpesa','stripe','wallet','manual')),
  provider_ref    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL DEFAULT 'KES',
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','success','failed')),
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_subscriber_idx ON payments (subscriber_id);
CREATE INDEX payments_provider_ref_idx ON payments (provider, provider_ref);

-- ---------------------------------------------------------------------
-- Voucher batches + vouchers (PHPNuxBill signature feature)
-- ---------------------------------------------------------------------
CREATE TABLE voucher_batches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reseller_id UUID REFERENCES resellers(id) ON DELETE SET NULL,
  plan_id     UUID NOT NULL REFERENCES plans(id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  prefix      TEXT NOT NULL DEFAULT '',
  cost_cents  BIGINT NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vouchers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  batch_id    UUID REFERENCES voucher_batches(id) ON DELETE SET NULL,
  plan_id     UUID NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'unused'
                CHECK (status IN ('unused','used','expired','disabled')),
  value_cents BIGINT NOT NULL DEFAULT 0,
  used_by     UUID REFERENCES subscribers(id) ON DELETE SET NULL,
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vouchers_batch_idx ON vouchers (batch_id);
CREATE INDEX vouchers_status_idx ON vouchers (status);

-- ---------------------------------------------------------------------
-- Usage metering / CDRs (simplified TimescaleDB stand-in) + FUP
-- ---------------------------------------------------------------------
CREATE TABLE usage_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  bytes_in      BIGINT NOT NULL DEFAULT 0,
  bytes_out     BIGINT NOT NULL DEFAULT 0,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_end    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usage_subscriber_idx ON usage_records (subscriber_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Provisioning actions (Network Integration Layer audit)
-- The real adapter would call Mikrotik RouterOS API / FreeRADIUS CoA.
-- ---------------------------------------------------------------------
CREATE TABLE provisioning_actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('activate','suspend','restore','throttle','unthrottle')),
  status        TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','failed')),
  detail        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provisioning_subscriber_idx ON provisioning_actions (subscriber_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Event bus stand-in (Kafka). Append-only; in-process handlers dispatch.
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic      TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_topic_idx ON events (topic, created_at DESC);
