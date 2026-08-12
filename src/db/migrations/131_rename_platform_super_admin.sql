-- 131_rename_platform_super_admin.sql
--
-- Moves the platform Super Admin login from superadmin@619studio.com to
-- abhishek@myptstudio.com and sets a new password.
--
-- ── Why a new migration rather than editing 091 ─────────────────────────
--
-- 091 seeds the account with `INSERT ... WHERE NOT EXISTS`. On any database
-- where it has already run the row exists, so editing 091 would change
-- nothing at all on the live platform — it would only affect a database
-- built from scratch, which is the one place it does not matter.
--
-- ── Idempotent by the OLD address, deliberately ─────────────────────────
--
-- The WHERE clause matches the old email. Once this has run, it matches
-- nothing and every later boot is a no-op. That matters: the migration
-- runner executes on every deploy, and a rerun that reset the password
-- would silently undo any password the operator sets afterwards through
-- the Control Centre. Guarding on the old address makes this a one-time
-- move rather than a recurring reset.
--
-- ── The password is a hash, and only a hash ─────────────────────────────
--
-- bcrypt, cost 12, generated with the app's own bcryptjs — the same
-- parameters as POST /users/:id/reset-password, so this account is not a
-- special case for verification. The plaintext was delivered out of band
-- and is not in git, following 091.
--
-- token_version is bumped for the same reason the reset-password route
-- bumps it: middleware/auth.js compares the JWT's token_version against
-- the row and rejects a mismatch. Without the bump, a session issued
-- under the old password would keep working after the change — which is
-- the whole point of changing it.
--
-- Email matching is case-insensitive because login is
-- `LOWER(u.email) = LOWER($1)`; the address is stored lowercase here so
-- what is in the row matches what is typed.
-- ============================================================

DO $$
DECLARE
  taken TEXT;
BEGIN
  -- Refuse to create a second account that answers to the same login.
  -- users.email has only a non-unique index (idx_users_email_lower), so
  -- nothing at the schema level would stop this; login selects by
  -- LOWER(email) and takes the first row, so two matches would mean an
  -- ambiguous, silently order-dependent sign-in.
  SELECT id INTO taken
    FROM public.users
   WHERE LOWER(email) = LOWER('abhishek@myptstudio.com')
     AND role <> 'super_admin'
   LIMIT 1;

  IF taken IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot move the super admin to abhishek@myptstudio.com: user % already uses that address', taken;
  END IF;

  UPDATE public.users
     SET email         = 'abhishek@myptstudio.com',
         password      = '$2a$12$S3lHdOXV9dS/5iYRrpaDi.r2KFFe90lioV26QK.LCh8hzsYu2BNJ.',
         token_version = token_version + 1,
         updated_at    = now()
   WHERE role = 'super_admin'
     AND LOWER(email) = LOWER('superadmin@619studio.com');
END $$;
