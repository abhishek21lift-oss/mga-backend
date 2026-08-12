-- Migration 019a: VOIDED — original content was a destructive DELETE FROM payments / pt_payments
-- This migration has been replaced with a no-op to prevent accidental data loss.
-- If duplicate records exist from migration 018, run the deduplicate script manually.
SELECT 1; -- no-op
