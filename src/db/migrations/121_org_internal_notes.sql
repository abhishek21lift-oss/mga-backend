-- ============================================================
-- 121_org_internal_notes.sql
--
-- Internal notes on a studio, for the Control Centre's Admin
-- Management module.
--
-- Operator-only context that belongs to the platform, not the tenant:
-- "moved to annual in Jan, wants white-label", "payment bounced twice,
-- watch renewal". A single free-text field rather than a notes table —
-- this is a scratchpad an operator reads while looking at the studio,
-- not a threaded record. If it ever needs authorship per entry, the
-- audit trail already captures who changed it and to what, so the
-- history is recoverable without a second table.
--
-- Deliberately NOT exposed on any tenant-facing endpoint: the studio's
-- own admins must never see what the platform wrote about them.
--
-- Idempotent.
-- ============================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS internal_notes TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS internal_notes_updated_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS internal_notes_updated_by TEXT;
