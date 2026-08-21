-- Persons master + Debts (given/received) and returns

CREATE TABLE IF NOT EXISTS persons (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_persons_user ON persons (user_id);

CREATE TABLE IF NOT EXISTS debts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  debt_type VARCHAR(20) NOT NULL CHECK (debt_type IN ('given', 'received')),
  debt_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debts_user_date ON debts (user_id, debt_date);
CREATE INDEX IF NOT EXISTS idx_debts_person ON debts (person_id);

CREATE TABLE IF NOT EXISTS debt_returns (
  id SERIAL PRIMARY KEY,
  debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
  return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debt_returns_debt ON debt_returns (debt_id);
