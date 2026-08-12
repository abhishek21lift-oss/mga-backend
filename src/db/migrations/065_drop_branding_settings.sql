-- ============================================================
-- 065_drop_branding_settings.sql
-- Removes the Branding settings page and Import Database feature,
-- per explicit request.
--
-- Branding has no dedicated table - just 6 rows in the generic
-- system_settings key-value store, only present if an admin had
-- actually saved branding settings. Cleaned up here so nothing is
-- left behind; harmless no-op if the rows never existed.
--
-- Import Database has no schema of its own - it wrote directly into
-- the existing pt_clients / pt_client_subscriptions tables (shared
-- with the unrelated PT-OS renewals feature), so there is nothing to
-- drop for that half of this removal; only the import-specific route
-- code goes away (see routes/import.js deletion in the same commit).
-- ============================================================

DELETE FROM system_settings
 WHERE key IN ('primary_color','accent_color','theme_mode','typeface','button_style','radius_style');
