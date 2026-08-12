-- ============================================================
-- 162_public_registration_function.sql
--
-- Lets an anonymous visitor submit a studio application once
-- DATABASE_URL points at app_tenant.
--
-- ── The problem ──────────────────────────────────────────────────────
--
-- Migration 157 classified every table by asking one question: does it
-- have an organization_id column? studio_registrations has one, so it
-- landed in the strict bucket:
--
--   USING/WITH CHECK (organization_id::text = current_setting('app.org_id', true))
--
-- But that column is deliberately NULL until a super admin approves the
-- application — 146 made it nullable for exactly that reason. A studio
-- registration is a PRE-TENANT object: it is somebody asking for an
-- organisation, and it has to survive being rejected, so no organisation
-- exists to scope it to.
--
-- The request is also anonymous, so nothing sets app.org_id. The check
-- becomes NULL = NULL, which is NULL, which is not true, and the insert
-- is refused:
--
--   new row violates row-level security policy for table "studio_registrations"
--
-- ── Why not simply add an INSERT policy ──────────────────────────────
--
-- Because it does not work, which was established by experiment rather
-- than argument. With a policy of the form
--
--   FOR INSERT TO app_tenant WITH CHECK (organization_id IS NULL)
--
-- a bare INSERT succeeds but INSERT ... RETURNING fails with the very
-- same error, because PostgreSQL requires a SELECT policy to hand back
-- the row it just wrote. The handler returns the created row to the
-- applicant, so the reported error would survive the fix.
--
-- Adding the SELECT policy that would make RETURNING work is the part
-- that must not happen: policies are OR-ed, so a SELECT policy wide
-- enough to cover a NULL-org row is wide enough for EVERY NULL-org row.
-- Any tenant session on the platform could then read every pending
-- application — applicant names, email addresses, mobile numbers and
-- the bcrypt password_hash. That trades an outage for a data breach.
--
-- ── What this does instead ───────────────────────────────────────────
--
-- One SECURITY DEFINER function that performs exactly this one insert.
-- It is the same shape already used for the pre-authentication lookups
-- in 160 and the reset operations in 161: a narrow, named crossing of a
-- boundary the caller cannot otherwise cross, rather than a hole in the
-- boundary itself.
--
-- It is deliberately NOT a generic write helper. It takes five values,
-- writes one table, and returns four columns. organization_id, status,
-- reviewed_at, reviewed_by and review_note are not parameters at all, so
-- an anonymous caller cannot supply them — not "they are validated", but
-- there is no channel through which to send them.
--
-- Business logic stays in JavaScript. Field validation, mobile
-- normalisation and bcrypt hashing all remain in the route handler; the
-- function receives an already-hashed password, so no plaintext ever
-- reaches SQL text or the query log. The only thing that moved into the
-- database is the duplicate check, and only because it had to: as
-- app_tenant those two lookups now silently return zero rows, so the
-- check fails OPEN. Running it inside the definer context is what makes
-- it true again.
--
-- Idempotent, and safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_submit_studio_registration(
  p_full_name     text,
  p_business_name text,
  p_mobile        text,
  p_email         text,
  p_password_hash text
)
RETURNS TABLE (
  registration_id     uuid,
  registration_status text,
  created_at          timestamptz,
  was_duplicate       boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned so the definer's privileges cannot be aimed at a caller-supplied
-- schema. pg_temp last, per the usual advice for SECURITY DEFINER.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_email text := lower(btrim(p_email));
  v_id    uuid;
  v_at    timestamptz;
BEGIN
  -- Defence in depth only. The route validates all five of these first and
  -- returns a specific message per field; this exists so the function is
  -- still safe if it is ever called from somewhere else.
  IF p_full_name IS NULL OR btrim(p_full_name) = ''
     OR p_business_name IS NULL OR btrim(p_business_name) = ''
     OR p_mobile IS NULL OR btrim(p_mobile) = ''
     OR v_email = '' OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$'
     OR p_password_hash IS NULL OR p_password_hash !~ '^\$2[aby]\$'
  THEN
    RAISE EXCEPTION 'invalid registration payload'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The duplicate check, atomic with the insert because both run in the
  -- caller's transaction under the definer's privileges. Two cases mean
  -- "already known": an application still awaiting review, and an address
  -- that already belongs to a user account.
  --
  -- The caller is told the same thing either way. An endpoint that
  -- distinguished them would answer "is this studio on the platform?" for
  -- anyone who asked, which is why 146's partial unique index exists and
  -- why the handler has always reported duplicates as success.
  IF EXISTS (
       SELECT 1 FROM public.studio_registrations
        WHERE lower(email) = v_email AND status = 'pending'
     )
     OR EXISTS (SELECT 1 FROM public.users WHERE lower(email) = v_email)
  THEN
    RETURN QUERY SELECT NULL::uuid, 'pending'::text, NULL::timestamptz, true;
    RETURN;
  END IF;

  -- organization_id and status are not parameters. They are written here
  -- as literals, so a pre-tenant row is the only row this function can
  -- create — it cannot attach an application to an existing organisation,
  -- and it cannot create one already approved.
  BEGIN
    INSERT INTO public.studio_registrations
      (full_name, business_name, mobile, email, password_hash, organization_id, status)
    VALUES
      (btrim(p_full_name), btrim(p_business_name), btrim(p_mobile), v_email,
       p_password_hash, NULL, 'pending')
    RETURNING id, studio_registrations.created_at INTO v_id, v_at;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race on idx_studio_registrations_pending_email. From the
    -- applicant's point of view that is still "pending", and it must look
    -- identical to the branch above or the race becomes the oracle.
    RETURN QUERY SELECT NULL::uuid, 'pending'::text, NULL::timestamptz, true;
    RETURN;
  END;

  -- Four columns, chosen rather than inherited: password_hash is not among
  -- them and SELECT * is not used, so widening the table cannot widen what
  -- an anonymous caller gets back.
  RETURN QUERY SELECT v_id, 'pending'::text, v_at, false;
END;
$fn$;

COMMENT ON FUNCTION public.platform_submit_studio_registration(text, text, text, text, text) IS
  'Anonymous studio application. The only supported write path to '
  'studio_registrations for app_tenant, which cannot insert directly because '
  'the row is pre-tenant (organization_id IS NULL) and 157 scopes the table '
  'strictly. Forces organization_id NULL and status pending; never returns '
  'password_hash. See 162_public_registration_function.sql.';

-- Not executable by the world. PUBLIC includes every role, and a
-- SECURITY DEFINER function granted to PUBLIC is a privilege escalation
-- waiting for a caller — the same mistake 131 had to clean up.
REVOKE ALL ON FUNCTION
  public.platform_submit_studio_registration(text, text, text, text, text) FROM PUBLIC;

-- Granted only to the role the API actually connects as. Guarded because a
-- fresh bootstrap runs this file whether or not 157 has created the role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION '
         || 'public.platform_submit_studio_registration(text, text, text, text, text) '
         || 'TO app_tenant';
  END IF;
END $$;
