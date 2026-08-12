-- ============================================================
-- 066_informed_consent.sql
-- Personal Training Informed Consent module.
--
-- Standalone from pt_consent_records/pt_parq_forms (062) — that table is
-- hard-FK'd to a PAR-Q form and captures a fixed 7-item consent specific
-- to health screening. This is a separate legal document (nature of
-- program, risks, benefits, client responsibilities, confidentiality,
-- voluntary participation, final declaration) signed once per PT
-- enrollment, independent of whether/when a PAR-Q was done.
--
-- Versioning: signed (completed) records are never overwritten. Editing a
-- completed consent creates a new row with version = previous + 1 and
-- previous_version_id pointing back; the prior row's status flips to
-- 'archived'. Draft rows are edited in place (no point versioning a draft).
-- ============================================================

CREATE TABLE IF NOT EXISTS pt_informed_consents (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id           TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  trainer_id          TEXT REFERENCES trainers(id) ON DELETE SET NULL,

  version             SMALLINT NOT NULL DEFAULT 1,
  previous_version_id TEXT REFERENCES pt_informed_consents(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'draft',
  -- draft | pending_client_signature | pending_trainer_signature | completed
  -- | revoked | expired | archived

  -- Client snapshot at signing time (independent of the live pt_clients
  -- row — a legal document should capture what was true when signed).
  full_name         TEXT NOT NULL,
  gender            TEXT,
  dob               DATE,
  mobile            TEXT,
  email             TEXT,
  emergency_contact TEXT,
  emergency_phone   TEXT,
  address           TEXT,
  occupation        TEXT,

  -- Section 4: Client Responsibilities + Section 6/7/8 acknowledgements.
  -- Fixed keys, see ACK_KEYS in informed-consent.routes.js:
  --   understands_risk, accurate_medical_history, will_inform_pain,
  --   will_stop_if_dizzy, will_stop_if_chest_pain, will_communicate_changes,
  --   will_follow_instructions, understands_confidentiality,
  --   voluntary_participation, final_declaration
  acknowledgements JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Section 5: Medical Clearance
  physician_advised_against BOOLEAN,
  physician_name             TEXT,
  hospital                    TEXT,
  medical_condition           TEXT,
  medical_clearance_file_url  TEXT,

  -- Signatures
  client_signature   TEXT,  -- base64 PNG
  trainer_signature  TEXT,
  witness_signature  TEXT,
  witness_name       TEXT,
  client_signed_at   TIMESTAMPTZ,
  trainer_signed_at  TIMESTAMPTZ,
  witness_signed_at  TIMESTAMPTZ,

  -- Capture metadata (recorded at completion)
  ip_address TEXT,
  device     TEXT,
  browser    TEXT,

  pdf_url TEXT,

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  CONSTRAINT pt_informed_consents_status_check
    CHECK (status IN (
      'draft','pending_client_signature','pending_trainer_signature',
      'completed','revoked','expired','archived'
    ))
);

CREATE INDEX IF NOT EXISTS pic_client_idx  ON pt_informed_consents (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pic_status_idx  ON pt_informed_consents (status);
CREATE INDEX IF NOT EXISTS pic_prevver_idx ON pt_informed_consents (previous_version_id);

-- Only one non-archived record per client should exist at a time — the
-- versioning workflow archives the old row in the same transaction that
-- creates the new one, so this catches accidental double-creation rather
-- than being part of the normal versioning path itself.
CREATE UNIQUE INDEX IF NOT EXISTS pic_one_active_per_client_idx
  ON pt_informed_consents (client_id)
  WHERE status NOT IN ('archived', 'revoked', 'expired');

ALTER TABLE public.pt_informed_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_direct_access ON public.pt_informed_consents;
CREATE POLICY deny_all_direct_access ON public.pt_informed_consents
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
