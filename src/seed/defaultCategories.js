const db = require("../db");

async function seedDefaultCategories() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      )
    `);

    // Drop legacy icon column if present
    await db.query(`
      ALTER TABLE categories
      DROP COLUMN IF EXISTS icon
    `);

    await db.query(
      `INSERT INTO categories (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING`,
      ["Home"]
    );
  } catch (error) {
    console.error("Failed to seed default categories:", error.message);
  }
}

module.exports = seedDefaultCategories;
