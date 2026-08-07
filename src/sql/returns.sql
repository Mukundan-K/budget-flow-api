-- Amount received from others against a payment / expense category
-- (e.g. brother paid 3000 toward your 9000 EMI → your contribution = 6000)

CREATE TABLE IF NOT EXISTS payment_returns (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_returns_payment
  ON payment_returns (payment_id);

CREATE TABLE IF NOT EXISTS expense_returns (
  id SERIAL PRIMARY KEY,
  expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  category VARCHAR(100) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_returns_expense
  ON expense_returns (expense_id);

CREATE INDEX IF NOT EXISTS idx_expense_returns_expense_category
  ON expense_returns (expense_id, category);
