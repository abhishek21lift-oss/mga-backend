-- ============================================================
-- 052_pt_clients_whatsapp_occupation.sql
-- Adds whatsapp and occupation columns to pt_clients for the
-- redesigned single-step client-intake form.
-- ============================================================

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS whatsapp   TEXT;
ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS occupation TEXT;
