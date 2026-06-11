-- =====================================================================
-- Network Twin Phase 2 — the customer lifecycle funnel. A LEAD is a
-- prospect, NOT a billable customer, so it lives in its own table (never
-- in customers.status) to avoid polluting billing/RADIUS queries. Leads are
-- mapped BEFORE installation for demand heatmaps; at the 'active' boundary a
-- lead converts into a real customer + service (next increment) and enters
-- the production twin. Plain lat/lng (PostGIS deferred, same as Phase 1).
-- =====================================================================

CREATE TABLE leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  phone                 TEXT,
  email                 TEXT,
  -- Funnel stage. lead -> survey -> scheduled -> installing -> active,
  -- with on_hold / lost as off-ramps.
  stage                 TEXT NOT NULL DEFAULT 'lead'
                          CHECK (stage IN ('lead', 'survey', 'scheduled', 'installing',
                                           'active', 'on_hold', 'lost')),
  service_interest      TEXT,                       -- pppoe | hotspot | ftth_gpon | ...
  source                TEXT,                       -- walk-in | website | whatsapp | sales | referral
  landmark              TEXT,
  notes                 TEXT,
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  -- Set when the lead becomes a paying customer (convert step).
  converted_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX leads_stage ON leads (stage);
CREATE INDEX leads_created ON leads (created_at DESC);

-- Stage-change audit trail (who moved a lead where, and why).
CREATE TABLE lead_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  note        TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_lead ON lead_events (lead_id, created_at DESC);
