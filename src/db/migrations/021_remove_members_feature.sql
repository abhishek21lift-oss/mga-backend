-- ============================================================
-- 021_remove_members_feature.sql
-- Removes members-specific tables (clients table is kept for PT OS)
-- ============================================================

-- Drop FK constraints on tables that reference subscriptions
ALTER TABLE IF EXISTS member_memberships DROP CONSTRAINT IF EXISTS member_memberships_subscription_id_fkey;
ALTER TABLE IF EXISTS holds_freezes DROP CONSTRAINT IF EXISTS holds_freezes_subscription_id_fkey;

-- Drop subscription-related indexes
DROP INDEX IF EXISTS renewals_client_idx;
DROP INDEX IF EXISTS renewals_date_idx;

-- Drop member-specific tables
DROP TABLE IF EXISTS renewals;
DROP TABLE IF EXISTS subscriptions CASCADE;

-- NOTE: The `clients` table is intentionally kept because it is
-- shared with PT OS, Attendance, Check-in, Finance, and other
-- features that depend on it.
