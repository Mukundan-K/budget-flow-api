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

/**
 * Payment types store name, flow, and is_income as independent fields:
 *   flow      — "incoming" | "outgoing" (money direction)
 *   is_income — boolean flag (income classification)
 * They are not derived from each other.
 */

const FLOW_VALUES = new Set(["incoming", "outgoing"]);

function parseIsIncome(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === true || value === 1 || value === "1") return true;
  if (value === "false" || value === false || value === 0 || value === "0") return false;
  return null;
}

/** Parse flow string → "incoming" | "outgoing" | null (invalid) | undefined (omitted). */
function parseFlow(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (
    normalized === "incoming" ||
    normalized === "income" ||
    normalized === "in"
  ) {
    return "incoming";
  }
  if (
    normalized === "outgoing" ||
    normalized === "expense" ||
    normalized === "out"
  ) {
    return "outgoing";
  }
  return null;
}

function mapPaymentType(row) {
  const flow = FLOW_VALUES.has(row.flow)
    ? row.flow
    : Boolean(row.is_income)
      ? "incoming"
      : "outgoing";

  return {
    id: row.id,
    name: row.name,
    flow,
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

  if (!partial || (body.is_income !== undefined && body.is_income !== null && body.is_income !== "")) {
    if (!partial && (body.is_income === undefined || body.is_income === null || body.is_income === "")) {
      // optional on create — default false
    } else if (body.is_income !== undefined && body.is_income !== null && body.is_income !== "") {
      if (parseIsIncome(body.is_income) === null) {
        errors.push("is_income must be a boolean");
      }
    }
  }

  if (body.flow !== undefined && body.flow !== null && body.flow !== "") {
    if (parseFlow(body.flow) === null) {
      errors.push("flow must be 'incoming' or 'outgoing'");
    }
  }

  // Alias: type → flow (only validates; resolved separately)
  if (
    (body.flow === undefined || body.flow === null || body.flow === "") &&
    body.type !== undefined &&
    body.type !== null &&
    body.type !== ""
  ) {
    if (parseFlow(body.type) === null) {
      errors.push("type must be 'incoming' or 'outgoing'");
    }
  }

  return errors;
}

function resolveFieldsFromBody(body, current = null) {
  const name =
    body.name !== undefined
      ? String(body.name).trim()
      : current
        ? current.name
        : "";

  let is_income;
  if (body.is_income !== undefined && body.is_income !== null && body.is_income !== "") {
    is_income = parseIsIncome(body.is_income);
  } else if (current) {
    is_income = Boolean(current.is_income);
  } else {
    is_income = false;
  }

  let flow;
  if (body.flow !== undefined && body.flow !== null && body.flow !== "") {
    flow = parseFlow(body.flow);
  } else if (
    (body.flow === undefined || body.flow === null || body.flow === "") &&
    body.type !== undefined &&
    body.type !== null &&
    body.type !== ""
  ) {
    flow = parseFlow(body.type);
  } else if (current) {
    flow = FLOW_VALUES.has(current.flow)
      ? current.flow
      : Boolean(current.is_income)
        ? "incoming"
        : "outgoing";
  } else {
    flow = "outgoing";
  }

  return { name, flow, is_income };
}

const SELECT_COLS = `id, name, flow, is_income, created_at`;

// Create payment type
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const { name, flow, is_income } = resolveFieldsFromBody(req.body);
    if (flow === null || is_income === null) {
      return badRequest(res, "Invalid flow or is_income");
    }

    const result = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, $2, $3)
       RETURNING ${SELECT_COLS}`,
      [name, flow, is_income]
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
// Independent filters: ?is_income=  and/or  ?flow=
router.get("/", async (req, res) => {
  try {
    const { is_income, type, flow } = req.query;
    const params = [];
    const conditions = [];

    if (is_income !== undefined) {
      const filterIncome = parseIsIncome(is_income);
      if (filterIncome === null) {
        return badRequest(res, "is_income must be a boolean");
      }
      params.push(filterIncome);
      conditions.push(`is_income = $${params.length}`);
    }

    const flowQuery = flow !== undefined ? flow : type;
    if (flowQuery !== undefined) {
      const filterFlow = parseFlow(flowQuery);
      if (filterFlow === null) {
        return badRequest(res, "flow must be 'incoming' or 'outgoing'");
      }
      params.push(filterFlow);
      conditions.push(`flow = $${params.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await db.query(
      `SELECT ${SELECT_COLS}
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
      `SELECT ${SELECT_COLS}
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

// Update (full)
router.put("/:id", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const { name, flow, is_income } = resolveFieldsFromBody(req.body);
    if (flow === null || is_income === null) {
      return badRequest(res, "Invalid flow or is_income");
    }

    const result = await db.query(
      `UPDATE payment_types
       SET name = $1, flow = $2, is_income = $3
       WHERE id = $4
       RETURNING ${SELECT_COLS}`,
      [name, flow, is_income, req.params.id]
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
      `SELECT ${SELECT_COLS}
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

    const { name, flow, is_income } = resolveFieldsFromBody(
      req.body,
      existing.rows[0]
    );
    if (flow === null || is_income === null) {
      return badRequest(res, "Invalid flow or is_income");
    }

    const result = await db.query(
      `UPDATE payment_types
       SET name = $1, flow = $2, is_income = $3
       WHERE id = $4
       RETURNING ${SELECT_COLS}`,
      [name, flow, is_income, req.params.id]
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
       RETURNING ${SELECT_COLS}`,
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
