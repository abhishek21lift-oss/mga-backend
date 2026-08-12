-- A plan the operator saw, so the thing that runs is the thing they approved.
--
-- The assistant never writes. It proposes: the server resolves who would be
-- affected and what would be said, stores that here, and shows it. Executing
-- quotes the plan id back. At execute time the server re-resolves from scratch
-- and compares the fingerprint — if the answer changed in between, the run is
-- refused rather than performed against a set the operator never saw.
--
-- consumed_at is the double-send guard. Execution claims the row with a
-- conditional UPDATE ... WHERE consumed_at IS NULL, so two concurrent taps on
-- Confirm cannot both win. For an action that sends WhatsApp messages to real
-- clients, "at most once" matters more than "at least once".

CREATE TABLE IF NOT EXISTS ai_action_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID,
  -- TEXT, not UUID: users.id is TEXT and seeded platform admins carry ids
  -- like 'usr-superadmin-001'. See user-id-columns.test.js — this exact
  -- mistake has shipped three times from other migrations.
  user_id          TEXT NOT NULL,
  action_id        TEXT NOT NULL,
  -- sha256 over the resolved recipient ids and the exact message body.
  fingerprint      TEXT NOT NULL,
  params           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What was shown, kept so an audit can answer "what did they approve?"
  -- rather than only "what did we send?".
  summary          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  result           JSONB
);

-- Execution looks a plan up by id and owner; nothing scans this table broadly.
CREATE INDEX IF NOT EXISTS ai_action_plans_user_idx
  ON ai_action_plans (user_id, created_at DESC);

-- Lets a cleanup job find expired, never-confirmed plans.
CREATE INDEX IF NOT EXISTS ai_action_plans_expiry_idx
  ON ai_action_plans (expires_at)
  WHERE consumed_at IS NULL;

-- No client key has any business reading approvals to message clients: the
-- rows carry recipient names and the exact text that was sent. The API
-- connects as the table owner and so bypasses RLS.
ALTER TABLE ai_action_plans ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ai_action_plans'
       AND policyname = 'deny_all_direct_access'
  ) THEN
    CREATE POLICY deny_all_direct_access ON ai_action_plans
      FOR ALL USING (false) WITH CHECK (false);
  END IF;

  -- Guarded: anon/authenticated are Supabase roles and do not exist on a plain
  -- Postgres. Migrations run automatically at boot, so an unguarded REVOKE
  -- would abort the boot of any deployment that is not Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ai_action_plans FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ai_action_plans FROM authenticated;
  END IF;
END $$;
