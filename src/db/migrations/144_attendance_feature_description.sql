-- ============================================================
-- 144_attendance_feature_description.sql
--
-- The 'attendance' feature is described to operators as
-- "QR check-in, kiosk mode and attendance records." Kiosk Mode is gone: it
-- ran the same QR scan against the same endpoint as the Check In screen and
-- differed only in chrome, so it was removed along with the two other
-- check-in paths that had accumulated (fingerprint and member-code entry).
--
-- The seed in 123_feature_manager.sql is corrected in the same commit, which
-- is what a database created from scratch reads. This migration is for the
-- databases that already ran 123 and will never run it again.
--
-- Text only. The operator-controlled switches (default_enabled, is_plan_gated,
-- global_enabled) are not touched here for the same reason 123 refuses to
-- overwrite them: a redeploy must never silently re-arm a kill switch.
-- ============================================================

UPDATE platform_features
   SET description = 'QR check-in and attendance records.'
 WHERE key = 'attendance'
   AND description = 'QR check-in, kiosk mode and attendance records.';
