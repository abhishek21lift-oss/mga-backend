-- 161_auth_reset_functions.sql
--
-- Password reset under RLS. Migration 160 fixed the two lookups that
-- authenticate a session; this covers the flow that has no session at all.
--
-- ── Why the reset flow needs more than a lookup ────────────────────────────
--
-- Both halves of password reset touch users before any tenant context exists,
-- and both WRITE:
--
--   forgot-password : find the user by email, then
--                     UPDATE users SET password_reset_token, …_expires
--   reset-password  : find the user by the hashed token, then
--                     UPDATE users SET password, token_version + 1,
--                     clear the token, and revoke refresh_tokens
--
-- Under enforcement the SELECT matches nothing, so the UPDATE that follows
-- also matches nothing. Nothing errors. The caller is told a reset link was
-- sent, or that the password was changed, and neither happened — the worst
-- shape of failure available for an account-recovery flow.
--
-- ── Why these are operations, not a "find user by token" primitive ─────────
--
-- A function that merely returned the user for a reset token would be a
-- reusable capability to turn a token into an identity, callable from
-- anywhere, forever. These instead perform the whole privileged step and
-- return only the id they acted on, so the capability granted to app_tenant
-- is "issue a reset for this address" and "consume this reset token" — not
-- "look up users".
--
-- Both are exact-match on already-hashed credentials, so neither can be used
-- to enumerate: the caller must present the full address or the full token.
-- Neither returns the password hash, the reset token, or any profile column.
--
-- The same SECURITY DEFINER hardening as 160: pinned search_path, EXECUTE
-- revoked from PUBLIC and granted only to app_tenant.

-- Issue a reset token. Returns the user id, or NULL when no such active
-- account exists — the caller must answer identically either way, which is
-- what keeps the endpoint enumeration-safe.
CREATE OR REPLACE FUNCTION public.auth_issue_reset_token(
  p_email        text,
  p_hashed_token text,
  p_ttl          interval DEFAULT interval '15 minutes'
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE users
     SET password_reset_token   = p_hashed_token,
         password_reset_expires = NOW() + p_ttl
   WHERE id = (
     SELECT id FROM users
      WHERE btrim(lower(email)) = btrim(lower(p_email))
        AND deleted_at IS NULL
      LIMIT 1
   )
  RETURNING id;
$$;

COMMENT ON FUNCTION public.auth_issue_reset_token(text, text, interval) IS
  'Password-reset step 1. Stores an already-hashed token against the account '
  'for an exact email address and returns its id, or NULL if there is none. '
  'Runs as owner because it precedes any tenant context.';

-- Consume a reset token: verify it is unexpired, set the new password, bump
-- token_version, clear the token, revoke refresh tokens. One statement, so
-- the password write and the revocation cannot diverge — the same reasoning
-- the route already documents for its data-modifying CTE.
CREATE OR REPLACE FUNCTION public.auth_consume_reset_token(
  p_hashed_token   text,
  p_password_hash  text
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH target AS (
    SELECT id FROM users
     WHERE password_reset_token = p_hashed_token
       AND password_reset_expires > NOW()
       AND deleted_at IS NULL
     LIMIT 1
  ), pw AS (
    UPDATE users u
       SET password               = p_password_hash,
           token_version          = u.token_version + 1,
           password_reset_token   = NULL,
           password_reset_expires = NULL,
           updated_at             = NOW()
      FROM target
     WHERE u.id = target.id
    RETURNING u.id
  ), revoked AS (
    UPDATE refresh_tokens
       SET revoked_at = NOW()
     WHERE user_id = (SELECT id FROM pw)
       AND revoked_at IS NULL
    RETURNING 1
  )
  SELECT id FROM pw;
$$;

COMMENT ON FUNCTION public.auth_consume_reset_token(text, text) IS
  'Password-reset step 2. Verifies an unexpired hashed token, sets the new '
  'password, bumps token_version and revokes refresh tokens atomically. '
  'Returns the user id, or NULL when the token is unknown or expired.';

REVOKE ALL ON FUNCTION public.auth_issue_reset_token(text, text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_consume_reset_token(text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_issue_reset_token(text, text, interval) TO app_tenant';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.auth_consume_reset_token(text, text) TO app_tenant';
  END IF;
END $$;
