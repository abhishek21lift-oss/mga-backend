-- ============================================================
-- 109_subscription_events_actor_id_text.sql
-- BUG FIX: subscription_events.actor_id was typed UUID (migration
-- 099), but every write path passes req.user.id straight through
-- (routes/subscription.js), and users.id is TEXT — some accounts
-- carry legacy, non-UUID-format ids (e.g. "usr-admin-001" for
-- seeded admins). For those users, every INSERT into
-- subscription_events (request-activation, request-change,
-- plan_changed, downgrade_scheduled, downgrade_cancelled, ...)
-- fails with "invalid input syntax for type uuid", so clicking
-- "Request this upgrade" (or any subscription action) silently
-- errors out with no event ever logged.
-- Widen actor_id to TEXT — every existing UUID value stays valid,
-- so this is a safe, non-destructive type change.
-- ============================================================

ALTER TABLE subscription_events ALTER COLUMN actor_id TYPE TEXT;
