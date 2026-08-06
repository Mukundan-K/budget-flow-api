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

function parseIsIncome(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === true || value === 1 || value === "1") return true;
  if (value === "false" || value === false || value === 0 || value === "0") return false;
  return null;
}

function mapPaymentType(row) {
  return {
    id: row.id,
    name: row.name,
    is_income: Boolean(row.is_income),
    created_at: row.created_at,
  };
}

function validatePayload(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.name !== undefined) {
    if (!body.name || String(body.name).trim() === "") {
      errors.push("name is required");
    }
  }

  if (body.is_income !== undefined && body.is_income !== null && body.is_income !== "") {
    if (parseIsIncome(body.is_income) === null) {
      errors.push("is_income must be a boolean");
    }
  }

  return errors;
}

// Create payment type
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const name = String(req.body.name).trim();
    const is_income = parseIsIncome(req.body.is_income) ?? false;

    const result = await db.query(
      `INSERT INTO payment_types (name, is_income)
       VALUES ($1, $2)
       RETURNING id, name, is_income, created_at`,
      [name, is_income]
    );

    return created(res, mapPaymentType(result.rows[0]), "Payment type created successfully");
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Payment type already exists");
    }
    console.error(err);
    return serverError(res, "Error creating payment type");
  }
});

// List payment types
router.get("/", async (req, res) => {
  try {
    const { is_income } = req.query;
    const params = [];
    let whereClause = "";

    if (is_income !== undefined) {
      const parsed = parseIsIncome(is_income);
      if (parsed === null) {
        return badRequest(res, "is_income must be a boolean");
      }
      params.push(parsed);
      whereClause = `WHERE is_income = $1`;
    }

    const result = await db.query(
      `SELECT id, name, is_income, created_at
       FROM payment_types
       ${whereClause}
       ORDER BY name ASC`,
      params
    );

    return success(
      res,
      result.rows.map(mapPaymentType),
      "Payment types fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching payment types");
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, is_income, created_at
       FROM payment_types
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Payment type not found");
    }

    return success(
      res,
      mapPaymentType(result.rows[0]),
      "Payment type fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching payment type");
  }
});

// Update
router.put("/:id", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const name = String(req.body.name).trim();
    const is_income = parseIsIncome(req.body.is_income) ?? false;

    const result = await db.query(
      `UPDATE payment_types
       SET name = $1, is_income = $2
       WHERE id = $3
       RETURNING id, name, is_income, created_at`,
      [name, is_income, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Payment type not found");
    }

    return success(
      res,
      mapPaymentType(result.rows[0]),
      "Payment type updated successfully"
    );
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Payment type already exists");
    }
    console.error(err);
    return serverError(res, "Error updating payment type");
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id, name, is_income, created_at
       FROM payment_types
       WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "Payment type not found");
    }

    const errors = validatePayload(req.body, { partial: true });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const name =
      req.body.name !== undefined
        ? String(req.body.name).trim()
        : current.name;
    const parsedIncome = parseIsIncome(req.body.is_income);
    const is_income =
      parsedIncome !== undefined ? parsedIncome : Boolean(current.is_income);

    const result = await db.query(
      `UPDATE payment_types
       SET name = $1, is_income = $2
       WHERE id = $3
       RETURNING id, name, is_income, created_at`,
      [name, is_income, req.params.id]
    );

    return success(
      res,
      mapPaymentType(result.rows[0]),
      "Payment type updated successfully"
    );
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Payment type already exists");
    }
    console.error(err);
    return serverError(res, "Error updating payment type");
  }
});

// Delete
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM payment_types
       WHERE id = $1
       RETURNING id, name, is_income, created_at`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Payment type not found");
    }

    return success(
      res,
      mapPaymentType(result.rows[0]),
      "Payment type deleted successfully"
    );
  } catch (err) {
    if (err.code === "23503") {
      return conflict(res, "Cannot delete payment type that is used by payments");
    }
    console.error(err);
    return serverError(res, "Error deleting payment type");
  }
});

module.exports = router;
