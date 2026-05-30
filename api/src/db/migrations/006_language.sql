-- =====================================================================
-- Subscriber language preference (Multi-language: Swahili/English priority).
-- =====================================================================

ALTER TABLE subscribers
  ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','sw'));
