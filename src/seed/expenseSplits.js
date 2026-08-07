const db = require("../db");

async function seedExpenseSplits() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS expense_category_splits (
        id SERIAL PRIMARY KEY,
        expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        expense_type BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE (expense_id, category)
      )
    `);

    // Add expense_type to existing splits table if missing
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'expense_category_splits'
            AND column_name = 'expense_type'
        ) THEN
          ALTER TABLE expense_category_splits
            ADD COLUMN expense_type BOOLEAN NOT NULL DEFAULT TRUE;
        END IF;
      END $$;
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_expense_category_splits_expense
        ON expense_category_splits (expense_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_expense_category_splits_category
        ON expense_category_splits (category)
    `);

    // Backfill one split per existing expense that has none yet
    await db.query(`
      INSERT INTO expense_category_splits
        (expense_id, category, amount, expense_type, sort_order)
      SELECT e.id, e.category, e.amount, COALESCE(e.expense_type, TRUE), 0
      FROM expenses e
      WHERE e.category IS NOT NULL
        AND TRIM(e.category) <> ''
        AND e.amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM expense_category_splits s WHERE s.expense_id = e.id
        )
    `);

    // Sync split expense_type from parent when still default-only legacy rows
    // (safe no-op for already customized splits: only updates rows matching parent)
    await db.query(`
      UPDATE expense_category_splits s
      SET expense_type = e.expense_type
      FROM expenses e
      WHERE s.expense_id = e.id
        AND (
          SELECT COUNT(*) FROM expense_category_splits x WHERE x.expense_id = e.id
        ) = 1
    `);
  } catch (error) {
    console.error("Failed to seed expense category splits:", error.message);
  }
}

module.exports = seedExpenseSplits;
