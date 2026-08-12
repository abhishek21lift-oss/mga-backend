-- Migration 016: Performance indexes
-- Created: 2026-06-01
--
-- Targeted indexes for hot query paths. Each CREATE INDEX is guarded with
-- information_schema checks so a missing column on legacy deployments
-- is silently skipped instead of failing the whole migration.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'branch_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_subscriptions_branch_id ON subscriptions(branch_id);
  END IF;
END $$;

-- Same guard as the subscriptions index above, which this one was missing:
-- clients.branch_id is added by migration 046, i.e. after this file, so on a
-- fresh database the index had no column to attach to and aborted the
-- migration. The file's own header already states this is the intended
-- pattern for exactly this case.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clients' AND column_name = 'branch_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_clients_branch_id
      ON clients(branch_id) WHERE deleted_at IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_deleted_at
  ON payments(deleted_at) WHERE deleted_at IS NOT NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clients' AND column_name = 'email'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_clients_email_lower ON clients(LOWER(email));
  END IF;
END $$;
