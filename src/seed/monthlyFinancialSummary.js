const db = require("../db");

async function seedMonthlyFinancialSummary() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS monthly_financial_summary (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        earned NUMERIC(18, 8) NOT NULL DEFAULT 0,
        not_earned NUMERIC(18, 8) NOT NULL DEFAULT 0,
        outgoing NUMERIC(18, 8) NOT NULL DEFAULT 0,
        expenses NUMERIC(18, 8) NOT NULL DEFAULT 0,
        savings_credited NUMERIC(18, 8) NOT NULL DEFAULT 0,
        savings_debited NUMERIC(18, 8) NOT NULL DEFAULT 0,
        given_total NUMERIC(18, 8) NOT NULL DEFAULT 0,
        given_returned NUMERIC(18, 8) NOT NULL DEFAULT 0,
        received_total NUMERIC(18, 8) NOT NULL DEFAULT 0,
        received_returned NUMERIC(18, 8) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, year, month)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_monthly_financial_summary_user_year
        ON monthly_financial_summary (user_id, year)
    `);
  } catch (error) {
    console.error("Failed to seed monthly_financial_summary:", error.message);
    throw error;
  }
}

module.exports = seedMonthlyFinancialSummary;
