-- 009_replace_stored_columns.sql
-- Replace STORED GENERATED columns with a VIEW.
-- STORED columns make ALTER TABLE operations brittle because the source
-- column cannot be modified without first dropping the dependent STORED column.
-- The alias columns are not directly referenced by any application queries.

ALTER TABLE clients DROP COLUMN IF EXISTS phone;
ALTER TABLE clients DROP COLUMN IF EXISTS membership_plan;
ALTER TABLE clients DROP COLUMN IF EXISTS join_date;
ALTER TABLE clients DROP COLUMN IF EXISTS expiry_date;
ALTER TABLE clients DROP COLUMN IF EXISTS balance_due;

-- Provide backward-compatible aliases via a view for any external consumers
CREATE OR REPLACE VIEW v_clients AS
SELECT *, mobile AS phone, package_type AS membership_plan,
       joining_date AS join_date, pt_end_date AS expiry_date,
       balance_amount AS balance_due
FROM clients;
