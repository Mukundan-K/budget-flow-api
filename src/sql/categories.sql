CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '/uploads/categories/default.svg'
);

INSERT INTO categories (name, icon)
VALUES ('Home', '/uploads/categories/home.svg')
ON CONFLICT (name) DO NOTHING;
