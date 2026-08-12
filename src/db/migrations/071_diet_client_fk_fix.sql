-- ============================================================
-- 071_diet_client_fk_fix.sql
-- diet_assignments, nutrition_logs, and client_fitness_profiles still
-- FK to the dead legacy `clients` table instead of `pt_clients` — the
-- same bug 063_fix_workout_assignments_fk.sql already fixed for
-- workout_assignments. Left as-is, any attempt to wire these tables to
-- a real PT-OS client (a pt_clients.id) fails with a FK violation.
-- ============================================================

ALTER TABLE diet_assignments DROP CONSTRAINT IF EXISTS diet_assignments_client_id_fkey;
ALTER TABLE diet_assignments ADD CONSTRAINT diet_assignments_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

ALTER TABLE nutrition_logs DROP CONSTRAINT IF EXISTS nutrition_logs_client_id_fkey;
ALTER TABLE nutrition_logs ADD CONSTRAINT nutrition_logs_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;

ALTER TABLE client_fitness_profiles DROP CONSTRAINT IF EXISTS client_fitness_profiles_client_id_fkey;
ALTER TABLE client_fitness_profiles ADD CONSTRAINT client_fitness_profiles_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES pt_clients(id) ON DELETE CASCADE;
