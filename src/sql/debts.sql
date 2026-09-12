-- Persons master + Debts (four transaction types)

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
  debt_type VARCHAR(20) NOT NULL CHECK (debt_type IN ('given', 'received', 'returned_by_me', 'returned_to_me')),
  debt_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_debts_user_date ON debts (user_id, debt_date);
CREATE INDEX IF NOT EXISTS idx_debts_person ON debts (person_id);