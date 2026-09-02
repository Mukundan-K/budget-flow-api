const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  created,
  badRequest,
  notFound,
  conflict,
  serverError,
} = require("../utils/response");

function validateName(name, { required = true } = {}) {
  if (name === undefined) {
    return required ? "name is required" : null;
  }
  if (!name || String(name).trim() === "") {
    return "name is required";
  }
  return null;
}

function mapCategory(row) {
  return {
    id: row.id,
    name: row.name,
  };
}

async function updateCategory(req, res) {
  try {
    const existing = await db.query(
      `SELECT id, name FROM categories WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "Category not found");
    }

    const nameError = validateName(req.body.name, {
      required: req.body.name !== undefined,
    });
    if (nameError) {
      return badRequest(res, nameError);
    }

    const current = existing.rows[0];
    const name =
      req.body.name !== undefined
        ? String(req.body.name).trim()
        : current.name;

    const result = await db.query(
      `UPDATE categories
       SET name = $1
       WHERE id = $2
       RETURNING id, name`,
      [name, req.params.id]
    );

    return success(res, mapCategory(result.rows[0]), "Category updated successfully");
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Category already exists");
    }
    console.error(err);
    return serverError(res, "Error updating category");
  }
}

// Create category — 201
router.post("/", async (req, res) => {
  try {
    const nameError = validateName(req.body.name);
    if (nameError) {
      return badRequest(res, nameError);
    }

    const name = String(req.body.name).trim();

    const result = await db.query(
      `INSERT INTO categories (name)
       VALUES ($1)
       RETURNING id, name`,
      [name]
    );

    return created(res, mapCategory(result.rows[0]), "Category created successfully");
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Category already exists");
    }
    console.error(err);
    return serverError(res, "Error creating category");
  }
});

// List categories — 200
// Optional filter: ?search=home (case-insensitive name match)
router.get("/", async (req, res) => {
  try {
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    let result;
    if (search) {
      result = await db.query(
        `SELECT id, name FROM categories
         WHERE name ILIKE $1
         ORDER BY name ASC`,
        [`%${search}%`]
      );
    } else {
      result = await db.query(
        `SELECT id, name FROM categories ORDER BY name ASC`
      );
    }

    return success(
      res,
      result.rows.map(mapCategory),
      "Categories fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching categories");
  }
});

// Get one category — 200
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name FROM categories WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Category not found");
    }

    return success(res, mapCategory(result.rows[0]), "Category fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching category");
  }
});

// Update category — 200
router.put("/:id", updateCategory);
router.patch("/:id", updateCategory);

// Delete category — 200
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM categories WHERE id = $1 RETURNING id, name`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Category not found");
    }

    return success(
      res,
      mapCategory(result.rows[0]),
      "Category deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting category");
  }
});

module.exports = router;
