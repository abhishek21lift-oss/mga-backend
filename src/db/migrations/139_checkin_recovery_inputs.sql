-- The three readings a recovery score actually needs.
--
-- weekly_checkins already captured sleep, hydration and mood. Stress, energy
-- and soreness were missing, and those three are what turn "they slept six
-- hours" into "do not add volume this week" — a recovery score built on sleep
-- alone is a sleep score wearing a different name.
--
-- All nullable, all optional. A trainer taking a thirty-second check-in at the
-- door should be able to record what the client actually said and leave the
-- rest blank; the score is only computed from the answers that are present,
-- and reports how many it had.
--
-- 1–10 self-report, matching the scale the lifestyle assessment already uses
-- for stress and energy, so the two sources are comparable. The CHECKs are
-- there because a 0 or a 75 in one of these silently drags any average built
-- on it, and a wrong recovery score is worse than none.

ALTER TABLE weekly_checkins
  ADD COLUMN IF NOT EXISTS stress_level   integer,
  ADD COLUMN IF NOT EXISTS energy_level   integer,
  ADD COLUMN IF NOT EXISTS soreness_level integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'weekly_checkins_stress_range'
  ) THEN
    ALTER TABLE weekly_checkins
      ADD CONSTRAINT weekly_checkins_stress_range
      CHECK (stress_level IS NULL OR stress_level BETWEEN 1 AND 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'weekly_checkins_energy_range'
  ) THEN
    ALTER TABLE weekly_checkins
      ADD CONSTRAINT weekly_checkins_energy_range
      CHECK (energy_level IS NULL OR energy_level BETWEEN 1 AND 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'weekly_checkins_soreness_range'
  ) THEN
    ALTER TABLE weekly_checkins
      ADD CONSTRAINT weekly_checkins_soreness_range
      CHECK (soreness_level IS NULL OR soreness_level BETWEEN 1 AND 10);
  END IF;
END $$;

COMMENT ON COLUMN weekly_checkins.stress_level   IS '1-10 self-report, 10 = most stressed. Higher is worse.';
COMMENT ON COLUMN weekly_checkins.energy_level   IS '1-10 self-report, 10 = most energetic. Higher is better.';
COMMENT ON COLUMN weekly_checkins.soreness_level IS '1-10 self-report, 10 = most sore. Higher is worse.';

-- The profile reads the latest few check-ins for one client on every open.
CREATE INDEX IF NOT EXISTS idx_weekly_checkins_client_week
  ON weekly_checkins (client_id, week_start_date DESC);
