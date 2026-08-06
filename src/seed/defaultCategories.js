const db = require("../db");

async function seedDefaultCategories() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        icon TEXT NOT NULL DEFAULT '/uploads/categories/default.svg'
      )
    `);

    await db.query(
      `INSERT INTO categories (name, icon)
       VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING`,
      ["Home", "/uploads/categories/home.svg"]
    );
  } catch (error) {
    console.error("Failed to seed default categories:", error.message);
  }
}

module.exports = seedDefaultCategories;
