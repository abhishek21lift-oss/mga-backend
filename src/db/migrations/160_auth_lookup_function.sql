-- 160_auth_lookup_function.sql
--
-- Make authentication possible under row-level security.
--
-- ── The problem ────────────────────────────────────────────────────────────
--
-- Tenant context comes from the authenticated user. The query that
-- authenticates that user therefore runs before any context exists, with
-- app.org_id unset. The users policy admits `organization_id IS NULL` rows in
-- that state, so every tenant user is invisible to the lookup trying to find
-- them. Measured on a test database as app_tenant with no context:
--
--     org-scoped users present : 22
--     org-scoped users visible :  0
--     visible                  :  1   (the org-less platform super-admin)
--
-- Fail-closed, so not a leak — but nobody with an organization can log in.
--
-- ── Why a SECURITY DEFINER function ────────────────────────────────────────
--
-- The alternatives were considered and rejected:
--
--   · BYPASSRLS on app_tenant, or logging in as postgres — hands every
--     runtime query the ability to ignore every policy, to fix one lookup.
--   · Widening the users policy — anything permissive enough to expose a row
--     before context exists is permissive enough to let an authenticated
--     tenant user enumerate other tenants' users, because a policy cannot
--     tell "pre-authentication" from "authenticated" apart.
--   · Column privileges — RLS is row-level; GRANT SELECT(col) does not
--     restore visibility of a row the policy hides.
--
-- A SECURITY DEFINER function is PostgreSQL's own mechanism for a narrow,
-- explicit, auditable exception. The exception lives in one function with a
-- fixed body rather than in a role capability or a broad policy, and what it
-- can return is bounded by the function, not by the caller.
--
-- What makes it safe here specifically:
--
--   · users.email carries a UNIQUE constraint, so an exact-match lookup
--     returns at most one row. There is no wildcard, no LIKE, no list — the
--     function cannot be used to enumerate.
--   · The caller must already know the full email address.
--   · It returns only what authentication needs. Not phone, not address, not
--     profile or financial data.
--   · search_path is pinned, so a caller cannot shadow `users` with their own
--     relation and have the definer read that instead — the standard
--     SECURITY DEFINER escalation, closed explicitly.
--   · EXECUTE is revoked from PUBLIC and granted only to app_tenant.
--
-- The password hash is returned because verification happens in the
-- application; it never leaves the server. A future refinement is to verify
-- inside the database and return only a boolean, which would remove the hash
-- from the application's memory entirely.

CREATE OR REPLACE FUNCTION public.auth_user_by_email(p_email text)
RETURNS TABLE (
  id                       text,
  name                     text,
  email                    text,
  role                     text,
  password                 text,
  token_version            integer,
  trainer_id               text,
  member_id                text,
  is_active                boolean,
  organization_id          uuid,
  organization_name        text,
  organization_logo_url    text,
  is_founder               boolean,
  founder_number           integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.name, u.email, u.role, u.password, u.token_version,
         u.trainer_id, u.member_id, u.is_active,
         u.organization_id, o.name, o.logo_url,
         o.is_founder, o.founder_number
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
   WHERE lower(u.email) = lower(p_email)
     AND u.is_active = true
     AND u.deleted_at IS NULL
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.auth_user_by_email(text) IS
  'Pre-authentication lookup. Runs as the function owner so RLS on users does '
  'not hide a tenant user from the query that is authenticating them. Exact '
  'email match only (users.email is UNIQUE), so it cannot enumerate.';

-- ── The same problem on every authenticated request ────────────────────────
--
-- Logging in is not the only lookup that happens before tenant context
-- exists. middleware/auth.js re-reads the user by id on EVERY request, to
-- check is_active and token_version so a disabled account or a revoked token
-- stops working immediately rather than at token expiry. That read also runs
-- before resolveOrgId — it is what resolveOrgId gets the organization from —
-- so under RLS it finds nothing and every authenticated request answers
-- "Account not found or disabled".
--
-- Same reasoning, same shape: exact match on the primary key, one row,
-- session-validation columns only.
CREATE OR REPLACE FUNCTION public.auth_user_by_id(p_id text)
RETURNS TABLE (
  id                       text,
  name                     text,
  email                    text,
  role                     text,
  trainer_id               text,
  member_id                text,
  pt_client_id             text,
  branch_id                text,
  organization_id          uuid,
  organization_name        text,
  organization_logo_url    text,
  organization_status      text,
  subscription_status      text,
  trial_ends_at            timestamptz,
  current_period_end       timestamptz,
  is_founder               boolean,
  founder_number           integer,
  is_active                boolean,
  token_version            integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.name, u.email, u.role, u.trainer_id, u.member_id, u.pt_client_id, u.branch_id,
         u.organization_id, o.name, o.logo_url,
         o.status, o.subscription_status, o.trial_ends_at, o.current_period_end,
         o.is_founder, o.founder_number,
         u.is_active, u.token_version
    FROM users u
    LEFT JOIN organizations o ON o.id = u.organization_id
   WHERE u.id = p_id
     AND u.deleted_at IS NULL
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.auth_user_by_id(text) IS
  'Per-request session validation. Same reasoning as auth_user_by_email: the '
  'lookup that establishes tenant context cannot itself be tenant-scoped. '
  'Primary-key match only, session columns only.';

-- Nobody by default; app_tenant explicitly.
REVOKE ALL ON FUNCTION public.auth_user_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_user_by_id(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_user_by_email(text) TO app_tenant';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_user_by_id(text) TO app_tenant';
  END IF;
END $$;
