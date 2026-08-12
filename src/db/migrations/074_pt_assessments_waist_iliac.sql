-- 074_pt_assessments_waist_iliac.sql
--
-- Fitness Testing's Anthropometric step splits waist measurement into two
-- distinct landmarks: the existing waist_cm column is relabeled "Waist
-- Narrowest (cm)" in the UI (no rename here — it stays the input the
-- Waist-Hip Ratio formula uses) and a new waist_iliac_cm column captures
-- the measurement at the iliac crest, recorded alongside it but not fed
-- into the WHR calculation.

ALTER TABLE pt_assessments ADD COLUMN IF NOT EXISTS waist_iliac_cm NUMERIC(5,1);
