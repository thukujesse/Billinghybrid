-- Selectable captive-portal design. The brand color still drives every theme;
-- `template` switches the overall look (background, card, header treatment).
ALTER TABLE hotspot_branding ADD COLUMN template TEXT NOT NULL DEFAULT 'classic'
  CHECK (template IN ('classic', 'aurora', 'minimal', 'sunset'));
