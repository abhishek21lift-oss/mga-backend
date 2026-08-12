-- 003_expenses.sql
-- Add expenses tracking table

CREATE TABLE IF NOT EXISTS expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category        TEXT NOT NULL DEFAULT 'other',
  description     TEXT NOT NULL DEFAULT '',
  amount          DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method  TEXT NOT NULL DEFAULT 'cash',
  receipt_url     TEXT,
  notes           TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'approved'
                    CHECK (status IN ('pending','approved','rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expenses_date_idx    ON expenses (expense_date);
CREATE INDEX IF NOT EXISTS expenses_category_idx ON expenses (category);
CREATE INDEX IF NOT EXISTS expenses_status_idx  ON expenses (status);
