-- Split expense totals across multiple categories
CREATE TABLE IF NOT EXISTS expense_category_splits (
  id SERIAL PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  category VARCHAR(100) NOT NULL,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount >= 0),
  expense_type BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (expense_id, category)
);

CREATE INDEX IF NOT EXISTS idx_expense_category_splits_expense
  ON expense_category_splits (expense_id);

CREATE INDEX IF NOT EXISTS idx_expense_category_splits_category
  ON expense_category_splits (category);

-- If table already existed without expense_type:
-- ALTER TABLE expense_category_splits
--   ADD COLUMN IF NOT EXISTS expense_type BOOLEAN NOT NULL DEFAULT TRUE;
