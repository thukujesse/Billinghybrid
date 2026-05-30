-- =====================================================================
-- KYC documents. Files live in object storage; this table tracks metadata
-- and review state. subscribers.kyc_status reflects the overall outcome.
-- =====================================================================

CREATE TABLE kyc_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  doc_type      TEXT NOT NULL CHECK (doc_type IN ('id_card','passport','selfie','other')),
  storage_key   TEXT NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','verified','rejected')),
  review_note   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kyc_subscriber_idx ON kyc_documents (subscriber_id, created_at DESC);
