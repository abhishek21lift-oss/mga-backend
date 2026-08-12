-- 092_organizations_logo_url.sql
-- Per-studio branding: each organization can have its own logo, shown in the
-- top bar and at the top of the side navigation. Nullable — studios without an
-- uploaded logo fall back to an auto-generated monogram in the UI.
-- The existing studio keeps its current logo.png mark.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_url TEXT;

UPDATE organizations
   SET logo_url = '/logo.png'
 WHERE slug = 'abhishek-pt-studio'
   AND logo_url IS NULL;
