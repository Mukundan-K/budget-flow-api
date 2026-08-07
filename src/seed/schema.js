/**
 * Core tables every other feature depends on.
 * Safe to run repeatedly. No API/calculation changes.
 */
const db = require("../db");

async function run(label, sql, params) {
  try {
    await db.query(sql, params);
  } catch (error) {
    console.error(`Failed to seed core schema [${label}]:`, error.message);
    throw error;
  }
}

async function seedSchema() {
  try {
    await run(
      "users",
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) NOT NULL UNIQUE,
        google_id VARCHAR(255) UNIQUE,
        photo TEXT,
        refresh_token TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`
    );

    // Drop unused password column if present (OAuth-only auth)
    try {
      await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS password`);
    } catch (error) {
      console.error("Failed to drop users.password:", error.message);
    }

    await run(
      "expenses",
      `CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        amount NUMERIC(18, 8) NOT NULL,
        expense_type BOOLEAN NOT NULL DEFAULT TRUE,
        expense_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        category VARCHAR(100) NOT NULL DEFAULT 'Home',
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      )`
    );

    await run(
      "idx_expenses",
      `CREATE INDEX IF NOT EXISTS idx_expenses_user_date
        ON expenses (user_id, expense_date)`
    );

    await migrateColumnToTimestamptz("expenses", "expense_date");
    await migrateColumnToNumeric("expenses", "amount");

    await run(
      "monthly_balances",
      `CREATE TABLE IF NOT EXISTS monthly_balances (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        year INTEGER NOT NULL,
        previous_month_balance NUMERIC(18, 8) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, month, year)
      )`
    );

    await migrateColumnToNumeric("monthly_balances", "previous_month_balance");
  } catch (error) {
    // already logged per-step
  }
}

async function migrateColumnToTimestamptz(table, column) {
  const allowed = {
    expenses: ["expense_date"],
    payments: ["payment_date"],
    emi_products: ["emi_start_from"],
  };
  if (!allowed[table] || !allowed[table].includes(column)) return;

  const check = await db.query(
    `SELECT data_type
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [table, column]
  );
  if (check.rows[0]?.data_type !== "date") return;

  await run(
    `${table}.${column}->timestamptz`,
    `ALTER TABLE ${table}
     ALTER COLUMN ${column} TYPE TIMESTAMPTZ
     USING ${column}::timestamptz`
  );
}

async function migrateColumnToNumeric(table, column) {
  const allowed = {
    expenses: ["amount"],
    payments: ["amount"],
    monthly_balances: ["previous_month_balance"],
  };
  if (!allowed[table] || !allowed[table].includes(column)) return;

  const check = await db.query(
    `SELECT numeric_precision, numeric_scale, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [table, column]
  );
  const row = check.rows[0];
  if (!row) return;
  if (
    row.data_type === "numeric" &&
    Number(row.numeric_precision) === 18 &&
    Number(row.numeric_scale) === 8
  ) {
    return;
  }
  if (
    row.data_type === "numeric" ||
    row.data_type === "double precision" ||
    row.data_type === "real" ||
    row.data_type === "integer" ||
    row.data_type === "bigint"
  ) {
    await run(
      `${table}.${column}->numeric`,
      `ALTER TABLE ${table}
       ALTER COLUMN ${column} TYPE NUMERIC(18, 8)`
    );
  }
}

module.exports = seedSchema;
module.exports.migrateColumnToTimestamptz = migrateColumnToTimestamptz;
module.exports.migrateColumnToNumeric = migrateColumnToNumeric;
