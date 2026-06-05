-- =====================================================================
-- router_metrics: time-series snapshots of per-router health + traffic.
--
-- The sampler worker queries radacct + WG handshake state every minute
-- and writes one row per router. The /network UI reads back from here
-- to render bandwidth-over-time charts and detect router-down deltas
-- between the alert-engine 5-min sweep.
--
-- Sized for retention of ~30 days at 1-min granularity per router:
--   30 days * 1440 samples/day * (say) 10 routers = ~430k rows.
-- The created_at index covers the "last N minutes" range scan that
-- every chart renders.
-- =====================================================================
CREATE TABLE IF NOT EXISTS router_metrics (
  id              BIGSERIAL PRIMARY KEY,
  router_id       UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  sampled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sum of bytes_in + bytes_out across live radacct sessions on this
  -- router at sample time. Diffing two consecutive rows gives bytes/sec.
  total_bytes_in  BIGINT NOT NULL DEFAULT 0,
  total_bytes_out BIGINT NOT NULL DEFAULT 0,
  -- Snapshot counts to chart "users online" alongside bandwidth.
  active_sessions INT NOT NULL DEFAULT 0,
  pppoe_sessions  INT NOT NULL DEFAULT 0,
  hotspot_sessions INT NOT NULL DEFAULT 0,
  -- WG liveness at sample time. true when last_handshake_at < 3 min old.
  wg_up           BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS router_metrics_router_time
  ON router_metrics (router_id, sampled_at DESC);
