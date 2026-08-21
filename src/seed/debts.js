const db = require("../db");

async function columnExists(table, column) {
  const result = await db.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [table, column]
  );
  return result.rows.length > 0;
}

async function seedDebts() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS persons (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (user_id, name)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_persons_user
        ON persons (user_id)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS debts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        debt_type VARCHAR(20) NOT NULL
          CHECK (debt_type IN ('given', 'received')),
        debt_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Migrate legacy free-text person_name → person_id
    const hasPersonName = await columnExists("debts", "person_name");
    const hasPersonId = await columnExists("debts", "person_id");

    if (hasPersonName && !hasPersonId) {
      await db.query(`
        ALTER TABLE debts
        ADD COLUMN person_id INTEGER REFERENCES persons(id) ON DELETE RESTRICT
      `);

      await db.query(`
        INSERT INTO persons (user_id, name)
        SELECT DISTINCT user_id, TRIM(person_name)
        FROM debts
        WHERE person_name IS NOT NULL AND TRIM(person_name) <> ''
        ON CONFLICT (user_id, name) DO NOTHING
      `);

      await db.query(`
        UPDATE debts d
        SET person_id = p.id
        FROM persons p
        WHERE p.user_id = d.user_id
          AND p.name = TRIM(d.person_name)
      `);

      await db.query(`
        ALTER TABLE debts
        ALTER COLUMN person_id SET NOT NULL
      `);

      await db.query(`
        ALTER TABLE debts
        DROP COLUMN person_name
      `);
    } else if (hasPersonName && hasPersonId) {
      // Partial migration leftover — finish cleanup if person_id is populated
      await db.query(`
        INSERT INTO persons (user_id, name)
        SELECT DISTINCT user_id, TRIM(person_name)
        FROM debts
        WHERE person_id IS NULL
          AND person_name IS NOT NULL
          AND TRIM(person_name) <> ''
        ON CONFLICT (user_id, name) DO NOTHING
      `);

      await db.query(`
        UPDATE debts d
        SET person_id = p.id
        FROM persons p
        WHERE d.person_id IS NULL
          AND p.user_id = d.user_id
          AND p.name = TRIM(d.person_name)
      `);

      const nulls = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM debts WHERE person_id IS NULL`
      );
      if (nulls.rows[0].cnt === 0) {
        await db.query(`
          ALTER TABLE debts
          ALTER COLUMN person_id SET NOT NULL
        `);
        await db.query(`
          ALTER TABLE debts
          DROP COLUMN IF EXISTS person_name
        `);
      }
    }

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_debts_user_date
        ON debts (user_id, debt_date)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_debts_type
        ON debts (user_id, debt_type)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_debts_person
        ON debts (person_id)
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS debt_returns (
        id SERIAL PRIMARY KEY,
        debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_debt_returns_debt
        ON debt_returns (debt_id)
    `);
  } catch (error) {
    console.error("Failed to seed debt tables:", error.message);
  }
}

module.exports = seedDebts;
