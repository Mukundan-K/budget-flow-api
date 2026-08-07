const db = require("../db");
const {
  migrateColumnToTimestamptz,
  migrateColumnToNumeric,
} = require("./schema");

async function seedPayments() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_types (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        is_income BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS emi_products (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_name VARCHAR(200) NOT NULL,
        emi_start_from TIMESTAMPTZ NOT NULL,
        already_paid INTEGER NOT NULL DEFAULT 0 CHECK (already_paid >= 0),
        number_of_emis INTEGER NOT NULL CHECK (number_of_emis > 0),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, product_name),
        CHECK (already_paid <= number_of_emis)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        amount NUMERIC(18, 8) NOT NULL,
        payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payment_type_id INTEGER NOT NULL REFERENCES payment_types(id) ON DELETE RESTRICT,
        emi_product_id INTEGER REFERENCES emi_products(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Legacy cleanup — unused column
    await db.query(`ALTER TABLE payments DROP COLUMN IF EXISTS note`);

    // Older DBs: add emi_product_id if table was created without it
    const emiCol = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'payments'
         AND column_name = 'emi_product_id'`
    );
    if (emiCol.rows.length === 0) {
      await db.query(`
        ALTER TABLE payments
          ADD COLUMN emi_product_id INTEGER
          REFERENCES emi_products(id) ON DELETE SET NULL
      `);
    }

    const alreadyPaidCol = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'emi_products'
         AND column_name = 'already_paid'`
    );
    if (alreadyPaidCol.rows.length === 0) {
      await db.query(`
        ALTER TABLE emi_products
          ADD COLUMN already_paid INTEGER NOT NULL DEFAULT 0
          CHECK (already_paid >= 0)
      `);
    }

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_user_date
        ON payments (user_id, payment_date)
    `);

    await migrateColumnToTimestamptz("payments", "payment_date");
    await migrateColumnToTimestamptz("emi_products", "emi_start_from");
    await migrateColumnToNumeric("payments", "amount");

    await db.query(
      `INSERT INTO payment_types (name, is_income)
       VALUES ($1, $2), ($3, $4), ($5, $6)
       ON CONFLICT (name) DO NOTHING`,
      ["Salary", true, "Rent", false, "EMI", false]
    );

    await db.query(`DROP TABLE IF EXISTS salaries CASCADE`);
  } catch (error) {
    console.error("Failed to seed payments:", error.message);
  }
}

module.exports = seedPayments;
