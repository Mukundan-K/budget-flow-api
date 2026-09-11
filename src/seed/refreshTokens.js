const db = require("../db");

async function seedRefreshTokens() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        jti UUID NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_jti
        ON refresh_tokens (jti)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
        ON refresh_tokens (user_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_active
        ON refresh_tokens (user_id)
        WHERE revoked_at IS NULL
    `);
  } catch (error) {
    console.error("Failed to seed refresh_tokens:", error.message);
    throw error;
  }
}

module.exports = seedRefreshTokens;
