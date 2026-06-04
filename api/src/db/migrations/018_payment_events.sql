-- =====================================================================
-- payment_events: durable, idempotent job queue for Daraja callbacks.
--
-- BEFORE: every callback ran settlement inline in the HTTP handler. If
-- the handler crashed mid-flight (DB blip, RADIUS down) the customer
-- paid but stayed offline, and Daraja did not redeliver — money was
-- taken, service was missing.
--
-- AFTER: the callback ENQUEUES one row here, ACKs Daraja within ms,
-- and a worker drains the queue asynchronously with exponential
-- backoff retries. UNIQUE (source, dedup_key) collapses duplicate
-- callback deliveries to a single job. The handler functions
-- (hotspot.handleDarajaCallback, payments.confirmPayment) already
-- short-circuit on status != 'pending' so even a re-run after a
-- partial settle is a no-op.
-- =====================================================================

CREATE TYPE payment_event_status AS ENUM (
  'pending',     -- waiting for the worker to claim it
  'processing',  -- claimed by a worker, in flight
  'success',     -- handler completed without error
  'failed',      -- handler errored, will be retried (attempts < max_attempts)
  'dead'         -- exhausted max_attempts, moved to DLQ
);

CREATE TABLE payment_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Routing key for the dispatcher. Common values:
  --   mpesa_hotspot  -> hotspot.handleDarajaCallback
  --   mpesa_payment  -> payments.confirmPayment
  --   manual_hotspot -> hotspot.completePurchase(simulated)
  source          TEXT NOT NULL,
  -- Per-source dedup key. For mpesa_* this is Daraja's CheckoutRequestID;
  -- guaranteed unique within a source. For manual_hotspot it's the same.
  dedup_key       TEXT NOT NULL,
  -- Full raw callback body (or whatever payload the handler needs).
  payload         JSONB NOT NULL,
  status          payment_event_status NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  -- Set when the worker claims the row; cleared on completion. The reaper
  -- treats rows still in 'processing' after stale_lock_ms as crashed and
  -- resets them to 'pending'.
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CONSTRAINT payment_events_dedup UNIQUE (source, dedup_key)
);

-- Hot path: worker poll picks rows due NOW where status is claimable.
CREATE INDEX payment_events_due
  ON payment_events (next_attempt_at)
  WHERE status IN ('pending','processing','failed');

-- Admin DLQ list — ordered by when they died.
CREATE INDEX payment_events_dead
  ON payment_events (updated_at DESC)
  WHERE status = 'dead';
