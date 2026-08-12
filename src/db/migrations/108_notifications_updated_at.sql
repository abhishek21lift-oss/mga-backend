-- ============================================================
-- 108_notifications_updated_at.sql
-- BUG FIX: trg_notifications_updated_at (a BEFORE UPDATE trigger
-- calling the shared set_updated_at() function — see migration
-- 037) was attached to the notifications table, but the table
-- was never given an updated_at column. Every UPDATE on
-- notifications (markRead / markAllRead) has therefore been
-- failing with "record NEW has no field updated_at", silently
-- swallowed by the frontend — so the "Mark all read" button and
-- reading individual notifications never actually persisted, and
-- the unread badge count never went to zero.
-- Additive-only: add the missing column so the existing trigger
-- has something to write to.
-- ============================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
