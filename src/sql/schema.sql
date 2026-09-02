-- Budget Flow — canonical schema reference (mirrors seed/*.js)
-- Feature tables kept as-is; unused columns removed (payments.note, users.password).

-- ========== CORE ==========
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  email VARCHAR(100) NOT NULL UNIQUE,
  google_id VARCHAR(255) UNIQUE,
  photo TEXT,
  refresh_token TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(18, 8) NOT NULL,
  expense_type BOOLEAN NOT NULL DEFAULT TRUE,
  expense_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  category VARCHAR(100) NOT NULL DEFAULT 'Home',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monthly_balances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INTEGER NOT NULL,
  previous_month_balance NUMERIC(18, 8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, month, year)
);

-- ========== CATALOG ==========
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS payment_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  flow VARCHAR(20) NOT NULL DEFAULT 'outgoing'
    CHECK (flow IN ('incoming', 'outgoing')),
  is_income BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== EXPENSES DETAIL ==========
CREATE TABLE IF NOT EXISTS expense_category_splits (
  id SERIAL PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  category VARCHAR(100) NOT NULL,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount >= 0),
  expense_type BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (expense_id, category)
);

CREATE TABLE IF NOT EXISTS expense_returns (
  id SERIAL PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  category VARCHAR(100) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== PAYMENTS ==========
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

CREATE TABLE IF NOT EXISTS payment_returns (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== SAVINGS ==========
CREATE TABLE IF NOT EXISTS bank_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS savings_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  transaction_type VARCHAR(10) NOT NULL CHECK (transaction_type IN ('credit', 'debit')),
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ========== PERSONS (debt counterparty master) ==========
CREATE TABLE IF NOT EXISTS persons (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, name)
);

-- ========== DEBTS ==========
CREATE TABLE IF NOT EXISTS debts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  debt_type VARCHAR(20) NOT NULL CHECK (debt_type IN ('given', 'received')),
  debt_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS debt_returns (
  id SERIAL PRIMARY KEY,
  debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
