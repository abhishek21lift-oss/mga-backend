-- 096_rebrand_gym_name.sql
-- Rebrand the studio display name from the old "619 Fitness Studio" default to
-- "MY PT STUDIO". Only touches the row while it still holds the old seeded
-- default, so a studio that has already set a custom name is left untouched.
-- Applied by the file-based migration runner on deploy.

UPDATE system_settings
   SET value = 'MY PT STUDIO',
       updated_at = NOW()
 WHERE key = 'gym_name'
   AND value = '619 Fitness Studio';
