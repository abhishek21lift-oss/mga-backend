-- ============================================================
-- 064_drop_staff_module.sql
-- Removes the "Staff & Access" / Team Management module entirely,
-- per explicit request. Both tables were empty (0 rows) at removal
-- time, confirmed via live query before writing this migration -
-- no data loss, no backfill needed.
--
-- staff_targets.staff_id -> staff.id (ON DELETE CASCADE) is the only
-- FK relationship involving these tables anywhere in the schema
-- (confirmed via full-migration search for "REFERENCES staff(") -
-- nothing else references them, so this is a clean removal.
--
-- Not touched: the `staff` role value in the general users.role /
-- Role type (a login-account role distinct from this module's
-- personnel directory), and the attendance_logs / QR check-in
-- system's 'staff' ref_type (a different, unrelated feature).
-- ============================================================

DROP TABLE IF EXISTS staff_targets;
DROP TABLE IF EXISTS staff;
