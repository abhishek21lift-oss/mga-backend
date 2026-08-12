-- 106_search_providers.sql
-- Makes the rest of the studio's records searchable from the top-bar box.
--
-- Two separate jobs:
--   1. Give workout_plans and diet_templates an organization_id, because
--      without one they cannot be tenant-scoped and therefore cannot be
--      searched safely.
--   2. Trigram indexes for every column the new search providers match on.
--
-- ── 1. Tenancy for the authored libraries ────────────────────────────────────
--
-- exercises, workout_plans and diet_templates are the three "catalogue" tables
-- in this schema, and none of them carries organization_id — the existing list
-- routes read them unscoped, while the per-client *assignments* built on top of
-- them (workout_assignments, diet_assignments) are scoped normally.
--
-- That is defensible for `exercises`, which is a seeded reference library of
-- ~890 movements shared by everyone. It is NOT defensible for workout_plans and
-- diet_templates: those are programmes a coach writes, and a programme name can
-- carry a client's name, a pricing tier, or a method the studio considers its
-- own. Search would make them enumerable by typing letters, which is a far
-- easier leak to hit than an undocumented list endpoint.
--
-- So both get organization_id, backfilled through created_by. The column is
-- NULLABLE on purpose: NULL means "shipped with the product, visible to
-- everyone", which is what the seeded rows are. Search reads it as
-- `organization_id IS NULL OR organization_id = <caller's org>`.
--
-- NOTE: this migration does not change the existing GET routes for these two
-- tables — they still read unscoped, exactly as before. Narrowing them is a
-- behaviour change for existing screens and belongs in its own change; this
-- migration lays the column so that change becomes a one-line WHERE clause, and
-- makes sure the NEW surface does not widen the exposure in the meantime.
--
-- Idempotent: safe to re-run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE workout_plans   ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE diet_templates  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

COMMENT ON COLUMN workout_plans.organization_id IS
  'Owning studio. NULL = product-seeded template, visible to every studio.';
COMMENT ON COLUMN diet_templates.organization_id IS
  'Owning studio. NULL = product-seeded template, visible to every studio.';

-- Backfill from the author. created_by is TEXT here and users.id is TEXT, so
-- this joins directly. Rows with no author, or an author whose account has been
-- removed, stay NULL — i.e. they fall back to "shared", which is the same
-- visibility they have had all along. This never REMOVES access from anyone.
UPDATE workout_plans p
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = p.created_by
   AND p.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

UPDATE diet_templates t
   SET organization_id = u.organization_id
  FROM users u
 WHERE u.id = t.created_by
   AND t.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workout_plans_org  ON workout_plans (organization_id);
CREATE INDEX IF NOT EXISTS idx_diet_templates_org ON diet_templates (organization_id);

-- ── 2. Trigram indexes for the new providers ─────────────────────────────────
--
-- Same reasoning as migration 105: every one of these is an unanchored
-- substring match, which no btree can serve. Only the columns search actually
-- matches on are indexed — an index on a column nothing searches is pure write
-- cost.

-- Exercises: the largest searchable corpus in the product by an order of
-- magnitude, and the one a coach reaches for mid-session.
CREATE INDEX IF NOT EXISTS idx_exercises_name_trgm
  ON exercises USING gin (lower(name) gin_trgm_ops);
-- Equipment and muscle are how a coach actually searches ("cable", "hamstring"),
-- so they are matched too. One index over the concatenation rather than three
-- separate ones: the query always tests them together.
CREATE INDEX IF NOT EXISTS idx_exercises_facets_trgm
  ON exercises USING gin (
    lower(coalesce(muscle_group, '') || ' ' || coalesce(target_muscle, '')
          || ' ' || coalesce(equipment, '') || ' ' || coalesce(body_part, '')) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS idx_workout_plans_name_trgm
  ON workout_plans USING gin (lower(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_diet_templates_name_trgm
  ON diet_templates USING gin (lower(name) gin_trgm_ops);

-- Invoices are looked up by number far more often than by anything else, and
-- the number is quoted from the middle as often as the start ("…-0142").
CREATE INDEX IF NOT EXISTS idx_invoices_no_trgm
  ON invoices USING gin (lower(invoice_no) gin_trgm_ops)
  WHERE invoice_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_client_name_trgm
  ON invoices USING gin (lower(client_name) gin_trgm_ops)
  WHERE client_name IS NOT NULL;

-- Payments: the reference is the receipt number a client quotes on the phone.
CREATE INDEX IF NOT EXISTS idx_pt_payments_ref_trgm
  ON pt_payments USING gin (lower(payment_ref) gin_trgm_ops)
  WHERE payment_ref IS NOT NULL;

-- Broadcasts are found by remembering a phrase from the subject line.
CREATE INDEX IF NOT EXISTS idx_communication_history_title_trgm
  ON communication_history USING gin (lower(title) gin_trgm_ops)
  WHERE title IS NOT NULL;

-- AI conversations are private to one user, so the user index does the
-- narrowing and the trigram index does the matching.
CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_title_trgm
  ON ai_conversations USING gin (lower(title) gin_trgm_ops)
  WHERE title IS NOT NULL;

-- Client-joined providers (invoices, payments, assessments) reduce to one
-- client's rows first, so the FK is the driving index.
CREATE INDEX IF NOT EXISTS idx_invoices_client       ON invoices (client_id);
CREATE INDEX IF NOT EXISTS idx_pt_payments_client    ON pt_payments (client_id);
CREATE INDEX IF NOT EXISTS idx_pt_assessments_client ON pt_assessments (client_id);
