-- ============================================================
-- 062_parq_health_screening.sql
-- PAR-Q + Health Screening + Medical Clearance + Digital Consent module.
--
-- Five tables instead of a fully-normalized dozen, following the same
-- convention as the other PT-OS assessment modules (054-058): one wide
-- "form" table per assessment with JSONB for flexible sub-sections, plus
-- separate tables only where the data has genuine 1-to-many or distinct
-- lifecycle semantics (family history rows, medical clearance approval
-- workflow, consent/signature capture, document uploads).
--
-- New tables — client_id references pt_clients(id) from the start, no
-- legacy-`clients`-table FK bug to fix later (see migration 063 for the
-- pre-existing bug in workout_assignments).
-- ============================================================

CREATE TABLE IF NOT EXISTS pt_parq_forms (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  client_id         TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  assessment_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  assessment_number SMALLINT,

  -- Step 1: Client snapshot at assessment time (independent of pt_clients,
  -- which may change later — a medical record should capture what was
  -- true when it was signed, not drift with the live profile).
  full_name         TEXT NOT NULL,
  gender            TEXT,
  dob               DATE,
  mobile            TEXT,
  email             TEXT,
  emergency_contact TEXT,
  emergency_phone   TEXT,
  blood_group       TEXT,
  height_cm         NUMERIC(5,1),
  weight_kg         NUMERIC(5,1),
  bmi               NUMERIC(4,1),
  trainer_name      TEXT,

  -- Step 2: Current Health (toggle + expand fields, kept as JSONB —
  -- ~20 heterogeneous yes/no + free-text + numeric fields per the spec)
  current_health JSONB,

  -- Step 3: Past Medical History
  past_history JSONB,

  -- Step 5: PAR-Q — 10 fixed questions, each with
  -- {question_id, answer: 'yes'|'no'|'not_sure', explanation, diagnosis_date,
  --  treatment, doctor_name, hospital, notes}
  parq_answers    JSONB,
  parq_yes_count  SMALLINT NOT NULL DEFAULT 0,

  -- Auto risk analysis (0 yes = low, 1-2 = medium, 3+ = high)
  risk_level   TEXT NOT NULL DEFAULT 'low',
  risk_message TEXT,

  -- Step 7: Trainer Notes
  trainer_notes JSONB,

  -- Workflow status
  status              TEXT NOT NULL DEFAULT 'draft',
  workout_gate_status TEXT NOT NULL DEFAULT 'blocked',

  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT pt_parq_forms_risk_level_check
    CHECK (risk_level IN ('low','medium','high')),
  CONSTRAINT pt_parq_forms_status_check
    CHECK (status IN ('draft','submitted','reviewed')),
  CONSTRAINT pt_parq_forms_gate_status_check
    CHECK (workout_gate_status IN ('blocked','cleared'))
);

CREATE INDEX IF NOT EXISTS ppf_client_date_idx ON pt_parq_forms (client_id, assessment_date DESC);
CREATE INDEX IF NOT EXISTS ppf_risk_level_idx  ON pt_parq_forms (risk_level) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ppf_gate_status_idx ON pt_parq_forms (workout_gate_status) WHERE deleted_at IS NULL;

-- Step 4: Family Medical History — a real repeating group (multiple family
-- members per form), so a child table rather than a JSONB blob.
CREATE TABLE IF NOT EXISTS pt_family_medical_history (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  parq_form_id   TEXT NOT NULL REFERENCES pt_parq_forms(id) ON DELETE CASCADE,
  relation       TEXT NOT NULL,
  heart_disease   BOOLEAN NOT NULL DEFAULT FALSE,
  diabetes        BOOLEAN NOT NULL DEFAULT FALSE,
  stroke          BOOLEAN NOT NULL DEFAULT FALSE,
  hypertension    BOOLEAN NOT NULL DEFAULT FALSE,
  cancer          BOOLEAN NOT NULL DEFAULT FALSE,
  hyperlipidemia  BOOLEAN NOT NULL DEFAULT FALSE,
  kidney_disease  BOOLEAN NOT NULL DEFAULT FALSE,
  sudden_death    BOOLEAN NOT NULL DEFAULT FALSE,
  age_of_onset    SMALLINT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pt_family_medical_history_relation_check
    CHECK (relation IN ('father','mother','brother','sister','grandparent'))
);

CREATE INDEX IF NOT EXISTS pfmh_form_idx ON pt_family_medical_history (parq_form_id);

-- Medical Clearance — its own approval lifecycle (pending/approved/rejected,
-- expiry, review), distinct from the PAR-Q form itself.
CREATE TABLE IF NOT EXISTS pt_medical_clearances (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  parq_form_id     TEXT NOT NULL REFERENCES pt_parq_forms(id) ON DELETE CASCADE,
  client_id        TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  doctor_name      TEXT,
  hospital         TEXT,
  clearance_date   DATE,
  certificate_url  TEXT,
  doctor_contact   TEXT,
  expiry_date      DATE,
  approval_status  TEXT NOT NULL DEFAULT 'pending',
  reviewed_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pt_medical_clearances_status_check
    CHECK (approval_status IN ('approved','rejected','pending'))
);

CREATE INDEX IF NOT EXISTS pmc_form_idx      ON pt_medical_clearances (parq_form_id);
CREATE INDEX IF NOT EXISTS pmc_client_idx    ON pt_medical_clearances (client_id);
CREATE INDEX IF NOT EXISTS pmc_expiry_idx    ON pt_medical_clearances (expiry_date) WHERE approval_status = 'approved';

-- Digital Consent + Signatures
CREATE TABLE IF NOT EXISTS pt_consent_records (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  parq_form_id        TEXT NOT NULL REFERENCES pt_parq_forms(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  -- {info_true, understands_risk, will_inform_changes, understands_incorrect_info_risk,
  --  voluntary_participation, consents_emergency_care, agrees_data_storage}
  consent_checkboxes  JSONB NOT NULL,
  client_signature    TEXT,   -- base64 PNG from canvas signature pad
  trainer_signature   TEXT,
  client_signed_at    TIMESTAMPTZ,
  trainer_signed_at   TIMESTAMPTZ,
  ip_address          TEXT,
  device              TEXT,
  browser             TEXT,
  location             TEXT,
  pdf_url             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pcr_form_idx   ON pt_consent_records (parq_form_id);
CREATE INDEX IF NOT EXISTS pcr_client_idx ON pt_consent_records (client_id);

-- Document uploads (medical reports, clearance certificates). Purpose-built
-- rather than reusing the pre-existing `client_documents` table, which is
-- untracked in migrations, has no FK integrity, and is unused (0 rows).
CREATE TABLE IF NOT EXISTS pt_parq_documents (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  parq_form_id TEXT REFERENCES pt_parq_forms(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES pt_clients(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL,
  file_name    TEXT,
  file_url     TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   INTEGER,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pt_parq_documents_type_check
    CHECK (doc_type IN ('medical_report','medical_certificate','other'))
);

CREATE INDEX IF NOT EXISTS ppd_form_idx   ON pt_parq_documents (parq_form_id);
CREATE INDEX IF NOT EXISTS ppd_client_idx ON pt_parq_documents (client_id);

-- RLS: same deny-all-direct-access convention as every other table (the
-- Express backend connects with a role that bypasses RLS; this only closes
-- the Supabase Data-API hole for anon/authenticated). Applied inline from
-- the start rather than needing a later hardening pass.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pt_parq_forms','pt_family_medical_history','pt_medical_clearances',
    'pt_consent_records','pt_parq_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS deny_all_direct_access ON public.%I', t);
    EXECUTE format('CREATE POLICY deny_all_direct_access ON public.%I FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)', t);
  END LOOP;
END $$;
