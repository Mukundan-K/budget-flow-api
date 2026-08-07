const db = require("../db");

async function seedSavings() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, name)
      )
    `);

    // Drop legacy account_number if present
    await db.query(`
      ALTER TABLE bank_accounts
      DROP COLUMN IF EXISTS account_number
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_accounts_user
        ON bank_accounts (user_id)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS savings_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        transaction_type VARCHAR(10) NOT NULL
          CHECK (transaction_type IN ('credit', 'debit')),
        transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE savings_transactions
      DROP COLUMN IF EXISTS note
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_savings_user_date
        ON savings_transactions (user_id, transaction_date)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_savings_bank
        ON savings_transactions (bank_account_id)
    `);
  } catch (error) {
    console.error("Failed to seed savings tables:", error.message);
  }
}

module.exports = seedSavings;
