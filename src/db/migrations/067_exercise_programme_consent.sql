-- ============================================================
-- 067_exercise_programme_consent.sql
-- Adds a distinct "Exercise Programme Consent" sub-section to the
-- Informed Consent record — its own verbatim consent text, checkbox,
-- date, and signature, separate from the main document's client/
-- trainer/witness signatures already captured on pt_informed_consents.
--
-- exercise_consent_text stores the exact text shown at signing time
-- (sent by the client, not hardcoded here) so the legal record is
-- preserved even if the canonical wording in the app is edited later.
-- ============================================================

ALTER TABLE pt_informed_consents ADD COLUMN IF NOT EXISTS exercise_consent_text TEXT;
ALTER TABLE pt_informed_consents ADD COLUMN IF NOT EXISTS exercise_consent_checked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pt_informed_consents ADD COLUMN IF NOT EXISTS exercise_consent_date DATE;
ALTER TABLE pt_informed_consents ADD COLUMN IF NOT EXISTS exercise_consent_signature TEXT;
ALTER TABLE pt_informed_consents ADD COLUMN IF NOT EXISTS exercise_consent_signed_at TIMESTAMPTZ;
