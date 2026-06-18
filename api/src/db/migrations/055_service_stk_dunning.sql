-- Auto-STK renewal dunning. When opted in, the expire worker fires an M-Pesa
-- STK renewal prompt to a lapsing PPPoE customer so they renew with one PIN tap
-- (no pre-loaded wallet needed). These columns cap and space out the prompts so
-- a customer is never spammed: attempts is capped per cycle, last_stk_dun_at
-- enforces a re-prompt cooldown. Both reset when the service renews.

ALTER TABLE services ADD COLUMN IF NOT EXISTS stk_dun_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS last_stk_dun_at TIMESTAMPTZ;
