const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
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

const uploadsDir = path.join(__dirname, "../../uploads/categories");
const DEFAULT_ICON = "/uploads/categories/default.svg";
const PROTECTED_ICONS = new Set(["default.svg", "home.svg"]);

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Icon must be an image file"));
    }
    cb(null, true);
  },
});

function iconUrl(filename) {
  return `/uploads/categories/${filename}`;
}

function removeIconFile(iconPath) {
  if (!iconPath) return;
  const filename = path.basename(iconPath);
  if (PROTECTED_ICONS.has(filename)) return;
  const fullPath = path.join(uploadsDir, filename);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

function validateName(name, { required = true } = {}) {
  if (name === undefined) {
    return required ? "name is required" : null;
  }
  if (!name || String(name).trim() === "") {
    return "name is required";
  }
  return null;
}

function handleUpload(req, res, next) {
  upload.single("icon")(req, res, (err) => {
    if (err) {
      return badRequest(res, err.message);
    }
    next();
  });
}

async function updateCategory(req, res) {
  try {
    const existing = await db.query(
      `SELECT id, name, icon FROM categories WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      if (req.file) removeIconFile(req.file.filename);
      return notFound(res, "Category not found");
    }

    const nameError = validateName(req.body.name, {
      required: req.body.name !== undefined,
    });
    if (nameError) {
      if (req.file) removeIconFile(req.file.filename);
      return badRequest(res, nameError);
    }

    const current = existing.rows[0];
    const name =
      req.body.name !== undefined
        ? String(req.body.name).trim()
        : current.name;
    const icon = req.file ? iconUrl(req.file.filename) : current.icon;

    const result = await db.query(
      `UPDATE categories
       SET name = $1, icon = $2
       WHERE id = $3
       RETURNING id, name, icon`,
      [name, icon, req.params.id]
    );

    if (req.file && current.icon) {
      removeIconFile(current.icon);
    }

    return success(res, result.rows[0], "Category updated successfully");
  } catch (err) {
    if (req.file) removeIconFile(req.file.filename);
    if (err.code === "23505") {
      return conflict(res, "Category already exists");
    }
    console.error(err);
    return serverError(res, "Error updating category");
  }
}

// Create category — 201
router.post("/", handleUpload, async (req, res) => {
  try {
    const nameError = validateName(req.body.name);
    if (nameError) {
      if (req.file) removeIconFile(req.file.filename);
      return badRequest(res, nameError);
    }

    const name = String(req.body.name).trim();
    const icon = req.file ? iconUrl(req.file.filename) : DEFAULT_ICON;

    const result = await db.query(
      `INSERT INTO categories (name, icon)
       VALUES ($1, $2)
       RETURNING id, name, icon`,
      [name, icon]
    );

    return created(res, result.rows[0], "Category created successfully");
  } catch (err) {
    if (req.file) removeIconFile(req.file.filename);
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
    const search = typeof req.query.search === "string"
      ? req.query.search.trim()
      : "";

    let result;
    if (search) {
      result = await db.query(
        `SELECT id, name, icon FROM categories
         WHERE name ILIKE $1
         ORDER BY name ASC`,
        [`%${search}%`]
      );
    } else {
      result = await db.query(
        `SELECT id, name, icon FROM categories ORDER BY name ASC`
      );
    }

    return success(res, result.rows, "Categories fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching categories");
  }
});

// Get one category — 200
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, icon FROM categories WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Category not found");
    }

    return success(res, result.rows[0], "Category fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching category");
  }
});

// Update category — 200
router.put("/:id", handleUpload, updateCategory);
router.patch("/:id", handleUpload, updateCategory);

// Delete category — 200
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM categories WHERE id = $1 RETURNING id, name, icon`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Category not found");
    }

    removeIconFile(result.rows[0].icon);

    return success(res, result.rows[0], "Category deleted successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting category");
  }
});

module.exports = router;
