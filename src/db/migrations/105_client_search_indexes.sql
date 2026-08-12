-- 105_client_search_indexes.sql
-- Indexes behind the global client search (GET /api/search).
--
-- The search has to satisfy three different typing habits from one box:
--   • a name, possibly misspelled  — "Rhul" must find "Rahul"
--   • a fragment of a phone number — "98765" must find +919876543210
--   • an email or client code      — partial, from any position
--
-- All three are unanchored (the user may start typing from the middle of the
-- value), which rules out plain btree: `LIKE '%x%'` cannot use one. pg_trgm
-- GIN indexes are the only structure that serves an unanchored substring match
-- AND a fuzzy similarity match from the same index, so each searchable column
-- gets one.
--
-- ── Why lower() and not unaccent() ───────────────────────────────────────────
-- unaccent() is STABLE, not IMMUTABLE (its behaviour depends on a dictionary
-- that can be reloaded), so Postgres refuses to build an index on it. The usual
-- workaround — wrapping it in a hand-rolled IMMUTABLE function — is a known
-- footgun: it lies to the planner, and a dictionary change silently corrupts
-- the index. lower() is genuinely immutable and covers the case-insensitivity
-- that actually matters here. Accent folding, if it is ever needed, belongs in
-- a generated column, not a fake-immutable index expression.
--
-- ── Why these are NOT partial on deleted_at ──────────────────────────────────
-- The obvious saving is `WHERE deleted_at IS NULL`, since most searches want
-- live clients. But search deliberately has a second group — Archived Clients —
-- and in this schema "archived" covers both soft-deleted rows and any client
-- that has left `status = 'active'` (see lib/subscription.js: leaving active is
-- what frees a seat). A partial index would leave exactly that group unindexed,
-- which is the group most likely to grow without bound. The space saved is not
-- worth an index that stops working on the half of the data that gets bigger.
--
-- Note: created without CONCURRENTLY because src/db/migrate.js runs each
-- migration inside a transaction. These tables are small; the lock is brief.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Name: the primary path. Serves both `lower(name) LIKE '%rah%'` (substring)
-- and `lower(name) % 'rhul'` (similarity), which is what makes typo tolerance
-- possible without a second index.
CREATE INDEX IF NOT EXISTS idx_pt_clients_name_trgm
  ON public.pt_clients USING gin (lower(name) gin_trgm_ops);

-- Mobile is already uniquely indexed, but that btree only answers equality and
-- left-anchored prefixes. A coach searching "8765" — the memorable tail of a
-- number — needs the unanchored path.
CREATE INDEX IF NOT EXISTS idx_pt_clients_mobile_trgm
  ON public.pt_clients USING gin (mobile gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_pt_clients_email_trgm
  ON public.pt_clients USING gin (lower(email) gin_trgm_ops)
  WHERE email IS NOT NULL;

-- The human-facing client code (e.g. "PT-0042"), as printed on invoices.
CREATE INDEX IF NOT EXISTS idx_pt_clients_client_id_trgm
  ON public.pt_clients USING gin (lower(client_id) gin_trgm_ops)
  WHERE client_id IS NOT NULL;

-- The fuzzy fallback (word_similarity) has no index that can serve it, so it is
-- driven by the tenant filter instead: reduce to one studio's rows first, then
-- score them. This composite makes that reduction cheap and also serves the
-- "active clients rank above archived" ordering.
CREATE INDEX IF NOT EXISTS idx_pt_clients_org_status_name
  ON public.pt_clients (organization_id, status, name);

COMMENT ON INDEX public.idx_pt_clients_name_trgm IS
  'Trigram GIN for global client search: unanchored substring + similarity() typo tolerance.';
