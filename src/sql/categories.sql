-- Expense categories master
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

INSERT INTO categories (name)
VALUES ('Home')
ON CONFLICT (name) DO NOTHING;
