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

function parseIsActive(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

function mapBankAccount(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    is_active: Boolean(row.is_active),
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

  if (!partial || body.user_id !== undefined) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (body.is_active !== undefined && body.is_active !== null && body.is_active !== "") {
    if (parseIsActive(body.is_active) === null) {
      errors.push("is_active must be a boolean");
    }
  }

  return errors;
}

// Create bank account
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const name = String(req.body.name).trim();
    const user_id = req.body.user_id;
    const is_active = parseIsActive(req.body.is_active) ?? true;

    const result = await db.query(
      `INSERT INTO bank_accounts (user_id, name, is_active)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [user_id, name, is_active]
    );

    return created(
      res,
      mapBankAccount(result.rows[0]),
      "Bank account created successfully"
    );
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Bank account with this name already exists for the user");
    }
    console.error(err);
    return serverError(res, "Error creating bank account");
  }
});

// List bank accounts
router.get("/", async (req, res) => {
  try {
    const { user_id, is_active } = req.query;
    const conditions = [];
    const params = [];

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    params.push(user_id);
    conditions.push(`user_id = $${params.length}`);

    if (is_active !== undefined) {
      const parsed = parseIsActive(is_active);
      if (parsed === null) {
        return badRequest(res, "is_active must be a boolean");
      }
      params.push(parsed);
      conditions.push(`is_active = $${params.length}`);
    }

    const result = await db.query(
      `SELECT * FROM bank_accounts
       WHERE ${conditions.join(" AND ")}
       ORDER BY name ASC`,
      params
    );

    return success(
      res,
      result.rows.map(mapBankAccount),
      "Bank accounts fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching bank accounts");
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM bank_accounts WHERE id = $1`, [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return notFound(res, "Bank account not found");
    }

    return success(
      res,
      mapBankAccount(result.rows[0]),
      "Bank account fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching bank account");
  }
});

// Full update
router.put("/:id", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const name = String(req.body.name).trim();
    const user_id = req.body.user_id;
    const is_active = parseIsActive(req.body.is_active) ?? true;

    const result = await db.query(
      `UPDATE bank_accounts
       SET user_id = $1,
           name = $2,
           is_active = $3
       WHERE id = $4
       RETURNING *`,
      [user_id, name, is_active, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Bank account not found");
    }

    return success(
      res,
      mapBankAccount(result.rows[0]),
      "Bank account updated successfully"
    );
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Bank account with this name already exists for the user");
    }
    console.error(err);
    return serverError(res, "Error updating bank account");
  }
});

// Partial update
router.patch("/:id", async (req, res) => {
  try {
    const existing = await db.query(`SELECT * FROM bank_accounts WHERE id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      return notFound(res, "Bank account not found");
    }

    const errors = validatePayload(req.body, { partial: true });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const name =
      req.body.name !== undefined ? String(req.body.name).trim() : current.name;
    const user_id = req.body.user_id ?? current.user_id;
    const parsedActive = parseIsActive(req.body.is_active);
    const is_active =
      parsedActive !== undefined ? parsedActive : current.is_active;

    const result = await db.query(
      `UPDATE bank_accounts
       SET user_id = $1,
           name = $2,
           is_active = $3
       WHERE id = $4
       RETURNING *`,
      [user_id, name, is_active, req.params.id]
    );

    return success(
      res,
      mapBankAccount(result.rows[0]),
      "Bank account updated successfully"
    );
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Bank account with this name already exists for the user");
    }
    console.error(err);
    return serverError(res, "Error updating bank account");
  }
});

// Delete
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM bank_accounts WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Bank account not found");
    }

    return success(
      res,
      mapBankAccount(result.rows[0]),
      "Bank account deleted successfully"
    );
  } catch (err) {
    if (err.code === "23503") {
      return conflict(
        res,
        "Cannot delete bank account with existing savings transactions"
      );
    }
    console.error(err);
    return serverError(res, "Error deleting bank account");
  }
});

module.exports = router;
