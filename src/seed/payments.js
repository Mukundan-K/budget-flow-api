const db = require("../db");

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
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        amount NUMERIC(18, 8) NOT NULL,
        payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payment_type_id INTEGER NOT NULL REFERENCES payment_types(id) ON DELETE RESTRICT,
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_payments_user_date
        ON payments (user_id, payment_date)
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

    // Add already_paid to emi_products if missing
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'emi_products' AND column_name = 'already_paid'
        ) THEN
          ALTER TABLE emi_products
            ADD COLUMN already_paid INTEGER NOT NULL DEFAULT 0
            CHECK (already_paid >= 0);
        END IF;
      END $$;
    `);

    // Add emi_product_id to payments if missing
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'payments' AND column_name = 'emi_product_id'
        ) THEN
          ALTER TABLE payments
            ADD COLUMN emi_product_id INTEGER
            REFERENCES emi_products(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Expand amount precision + migrate date columns to timestamptz
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'payments' AND column_name = 'amount'
        ) THEN
          ALTER TABLE payments
            ALTER COLUMN amount TYPE NUMERIC(18, 8);
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'payments' AND column_name = 'payment_date'
            AND data_type = 'date'
        ) THEN
          ALTER TABLE payments
            ALTER COLUMN payment_date TYPE TIMESTAMPTZ
            USING payment_date::timestamp AT TIME ZONE;
          ALTER TABLE payments
            ALTER COLUMN payment_date SET DEFAULT NOW();
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'emi_products' AND column_name = 'emi_start_from'
            AND data_type = 'date'
        ) THEN
          ALTER TABLE emi_products
            ALTER COLUMN emi_start_from TYPE TIMESTAMPTZ
            USING emi_start_from::timestamp AT TIME ZONE;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'expenses' AND column_name = 'amount'
        ) THEN
          ALTER TABLE expenses
            ALTER COLUMN amount TYPE NUMERIC(18, 8);
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'expenses' AND column_name = 'expense_date'
            AND data_type = 'date'
        ) THEN
          ALTER TABLE expenses
            ALTER COLUMN expense_date TYPE TIMESTAMPTZ
            USING expense_date::timestamp AT TIME ZONE;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'monthly_balances'
            AND column_name = 'previous_month_balance'
        ) THEN
          ALTER TABLE monthly_balances
            ALTER COLUMN previous_month_balance TYPE NUMERIC(18, 8);
        END IF;
      END $$;
    `);

    await db.query(
      `INSERT INTO payment_types (name, is_income)
       VALUES ($1, $2), ($3, $4), ($5, $6)
       ON CONFLICT (name) DO NOTHING`,
      ["Salary", true, "Rent", false, "EMI", false]
    );

    // Drop legacy salaries table if it exists
    await db.query(`DROP TABLE IF EXISTS salaries CASCADE`);
  } catch (error) {
    console.error("Failed to seed payments:", error.message);
  }
}

module.exports = seedPayments;
