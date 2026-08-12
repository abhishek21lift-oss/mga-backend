-- 115_pt_clients_previous_trainer_experience.sql
-- Moves "previously worked with a trainer" from the PAR-Q health screening
-- (where it never belonged — it's a training-history question, not a
-- medical one) to PT enrollment, alongside Training Mode and Workout
-- Experience. Same convention as 077_pt_clients_workout_experience.sql:
-- captured once at enrollment rather than only inferred from PAR-Q history.
ALTER TABLE pt_clients
  ADD COLUMN IF NOT EXISTS previous_trainer_experience BOOLEAN NOT NULL DEFAULT FALSE;
