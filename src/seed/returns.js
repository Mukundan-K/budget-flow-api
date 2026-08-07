const db = require("../db");

async function seedReturns() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_returns (
        id SERIAL PRIMARY KEY,
        payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE payment_returns
      DROP COLUMN IF EXISTS note
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_payment_returns_payment
        ON payment_returns (payment_id)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS expense_returns (
        id SERIAL PRIMARY KEY,
        expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
        category VARCHAR(100) NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE expense_returns
      DROP COLUMN IF EXISTS note
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_expense_returns_expense
        ON expense_returns (expense_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_expense_returns_expense_category
        ON expense_returns (expense_id, category)
    `);
  } catch (error) {
    console.error("Failed to seed return tables:", error.message);
  }
}

module.exports = seedReturns;
