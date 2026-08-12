-- 076_pt_assessments_endurance_dual_test.sql
-- Muscular Endurance (Fitness Testing step 6) now requires two distinct
-- tests instead of one (e.g. an upper-body test + a core test), matching
-- standard endurance-battery assessment practice. Adds a persisted column
-- for the first test's type (previously computed but never actually
-- saved — a pre-existing data-loss bug) plus a full second test's type
-- and classification. endurance_category/endurance_score_computed keep
-- their existing meaning: test 1's classification, and the combined
-- (averaged) score used everywhere else in the app.

ALTER TABLE pt_assessments
  ADD COLUMN IF NOT EXISTS endurance_test_type TEXT,
  ADD COLUMN IF NOT EXISTS endurance_test_type_2 TEXT,
  ADD COLUMN IF NOT EXISTS endurance_category_2 TEXT;
