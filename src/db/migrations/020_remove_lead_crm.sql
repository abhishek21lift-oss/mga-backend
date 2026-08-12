-- ============================================================
-- 020_remove_lead_crm.sql
-- Removes all Lead CRM tables and references
-- ============================================================

-- Drop foreign key constraint on trial_sessions before dropping leads
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'trial_sessions_lead_id_fkey'
      AND table_name = 'trial_sessions'
  ) THEN
    ALTER TABLE trial_sessions DROP CONSTRAINT trial_sessions_lead_id_fkey;
  END IF;
END $$;

-- Drop lead-specific indexes
DROP INDEX IF EXISTS leads_status_idx;
DROP INDEX IF EXISTS leads_source_idx;
DROP INDEX IF EXISTS leads_assigned_idx;
DROP INDEX IF EXISTS leads_created_idx;
DROP INDEX IF EXISTS lf_lead_idx;
DROP INDEX IF EXISTS lf_scheduled_idx;
DROP INDEX IF EXISTS ts_lead_idx;

-- Drop lead tables
DROP TABLE IF EXISTS lead_followups;
DROP TABLE IF EXISTS leads;
