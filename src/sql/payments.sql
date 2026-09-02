-- Payments domain (see also schema.sql)

CREATE TABLE IF NOT EXISTS payment_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  flow VARCHAR(20) NOT NULL DEFAULT 'outgoing'
    CHECK (flow IN ('incoming', 'outgoing')),
  is_income BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

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
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(18, 8) NOT NULL,
  payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_type_id INTEGER NOT NULL REFERENCES payment_types(id) ON DELETE RESTRICT,
  emi_product_id INTEGER REFERENCES emi_products(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_date
  ON payments (user_id, payment_date);

CREATE TABLE IF NOT EXISTS monthly_balances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL,
  previous_month_balance NUMERIC(18, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, month, year)
);
