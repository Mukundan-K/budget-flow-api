const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  created,
  badRequest,
  forbidden,
  notFound,
  conflict,
  serverError,
} = require("../utils/response");
const { parseTimestamp, formatTimestamp } = require("../utils/datetime");
const {
  enrichEmiProduct,
  paidCountFromRow,
  previouslyPaidFromRow,
  listEmiProductsWithPaidMonths,
  fetchEmiProductWithPaidMonths,
} = require("../services/financial");

function mapEmiProduct(row) {
  if (!row) return row;
  return enrichEmiProduct({
    id: row.id,
    user_id: row.user_id,
    product_name: row.product_name,
    start_date: formatTimestamp(row.emi_start_from),
    already_paid: previouslyPaidFromRow(row),
    paid_months: paidCountFromRow(row),
    number_of_emis: Number(row.number_of_emis),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  });
}

function parseInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && !/^-?\d+$/.test(String(value).trim())) {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function validatePayload(body, { partial = false } = {}) {
  const errors = [];
  let alreadyPaid = null;
  let numberOfEmis = null;

  if (!partial || body.user_id !== undefined) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (!partial || body.product_name !== undefined) {
    if (!body.product_name || String(body.product_name).trim() === "") {
      errors.push("product_name is required");
    }
  }

  if (!partial || body.start_date !== undefined || body.emi_start_from !== undefined) {
    const startDate = body.start_date ?? body.emi_start_from;
    if (startDate === undefined || startDate === null || startDate === "") {
      errors.push("start_date is required");
    } else if (parseTimestamp(startDate) == null) {
      errors.push("start_date must be a valid date or timestamp");
    }
  }

  if (!partial || body.already_paid !== undefined) {
    if (
      body.already_paid === undefined ||
      body.already_paid === null ||
      body.already_paid === ""
    ) {
      errors.push("already_paid is required");
    } else {
      alreadyPaid = parseInteger(body.already_paid);
      if (alreadyPaid === null || alreadyPaid < 0) {
        errors.push("already_paid must be an integer >= 0");
      }
    }
  }

  if (!partial || body.number_of_emis !== undefined) {
    if (
      body.number_of_emis === undefined ||
      body.number_of_emis === null ||
      body.number_of_emis === ""
    ) {
      errors.push("number_of_emis is required");
    } else {
      numberOfEmis = parseInteger(body.number_of_emis);
      if (numberOfEmis === null || numberOfEmis <= 0) {
        errors.push("number_of_emis must be a positive integer");
      }
    }
  }

  if (
    alreadyPaid !== null &&
    alreadyPaid >= 0 &&
    numberOfEmis !== null &&
    numberOfEmis > 0 &&
    alreadyPaid > numberOfEmis
  ) {
    errors.push("already_paid cannot be greater than number_of_emis");
  }

  return errors;
}

function assertOwnership(existing, userId) {
  if (userId === undefined || userId === null || userId === "") return null;
  if (String(existing.user_id) !== String(userId)) {
    return "EMI product does not belong to this user";
  }
  return null;
}

function handleWriteError(err, res, fallbackMessage) {
  if (err.code === "23505") {
    return conflict(res, "EMI product with this name already exists for the user");
  }
  if (err.code === "23514") {
    return badRequest(res, "already_paid cannot be greater than number_of_emis");
  }
  console.error(err);
  return serverError(res, fallbackMessage);
}

// List EMI products
// GET /api/emi-products?user_id=1
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const rows = await listEmiProductsWithPaidMonths(user_id);

    return success(
      res,
      rows.map(mapEmiProduct),
      "EMI products fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching EMI products");
  }
});

// Get one EMI product
router.get("/:id", async (req, res) => {
  try {
    const row = await fetchEmiProductWithPaidMonths(req.params.id);

    if (!row) {
      return notFound(res, "EMI product not found");
    }

    return success(
      res,
      mapEmiProduct(row),
      "EMI product fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching EMI product");
  }
});

// Create EMI product
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const user_id = req.body.user_id;
    const product_name = String(req.body.product_name).trim();
    const emi_start_from = parseTimestamp(
      req.body.start_date ?? req.body.emi_start_from
    );
    const already_paid = parseInteger(req.body.already_paid);
    const number_of_emis = parseInteger(req.body.number_of_emis);

    const result = await db.query(
      `INSERT INTO emi_products
         (user_id, product_name, emi_start_from, already_paid, number_of_emis)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user_id, product_name, emi_start_from, already_paid, number_of_emis]
    );

    const row = await fetchEmiProductWithPaidMonths(result.rows[0].id);

    return created(
      res,
      mapEmiProduct(row),
      "EMI product created successfully"
    );
  } catch (err) {
    return handleWriteError(err, res, "Error creating EMI product");
  }
});

// Full update
router.put("/:id", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const existing = await db.query(
      `SELECT id, user_id FROM emi_products WHERE id = $1`,
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      return notFound(res, "EMI product not found");
    }

    const ownershipError = assertOwnership(existing.rows[0], req.body.user_id);
    if (ownershipError) {
      return forbidden(res, ownershipError);
    }

    const product_name = String(req.body.product_name).trim();
    const emi_start_from = parseTimestamp(
      req.body.start_date ?? req.body.emi_start_from
    );
    const already_paid = parseInteger(req.body.already_paid);
    const number_of_emis = parseInteger(req.body.number_of_emis);

    const result = await db.query(
      `UPDATE emi_products
       SET product_name = $1,
           emi_start_from = $2,
           already_paid = $3,
           number_of_emis = $4
       WHERE id = $5 AND user_id = $6
       RETURNING id`,
      [
        product_name,
        emi_start_from,
        already_paid,
        number_of_emis,
        req.params.id,
        existing.rows[0].user_id,
      ]
    );

    if (result.rows.length === 0) {
      return notFound(res, "EMI product not found");
    }

    const row = await fetchEmiProductWithPaidMonths(result.rows[0].id);

    return success(
      res,
      mapEmiProduct(row),
      "EMI product updated successfully"
    );
  } catch (err) {
    return handleWriteError(err, res, "Error updating EMI product");
  }
});

// Partial update
router.patch("/:id", async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id, user_id, product_name, emi_start_from, already_paid, number_of_emis, created_at
       FROM emi_products
       WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "EMI product not found");
    }

    const errors = validatePayload(req.body, { partial: true });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const requestedUserId = req.body.user_id ?? current.user_id;
    const ownershipError = assertOwnership(current, requestedUserId);
    if (ownershipError) {
      return forbidden(res, ownershipError);
    }

    const product_name =
      req.body.product_name !== undefined
        ? String(req.body.product_name).trim()
        : current.product_name;
    const emi_start_from =
      req.body.start_date !== undefined || req.body.emi_start_from !== undefined
        ? parseTimestamp(req.body.start_date ?? req.body.emi_start_from)
        : current.emi_start_from;
    const already_paid =
      req.body.already_paid !== undefined
        ? parseInteger(req.body.already_paid)
        : Number(current.already_paid);
    const number_of_emis =
      req.body.number_of_emis !== undefined
        ? parseInteger(req.body.number_of_emis)
        : Number(current.number_of_emis);

    if (
      already_paid != null &&
      number_of_emis != null &&
      already_paid > number_of_emis
    ) {
      return badRequest(
        res,
        "already_paid cannot be greater than number_of_emis"
      );
    }

    const result = await db.query(
      `UPDATE emi_products
       SET product_name = $1,
           emi_start_from = $2,
           already_paid = $3,
           number_of_emis = $4
       WHERE id = $5 AND user_id = $6
       RETURNING id`,
      [
        product_name,
        emi_start_from,
        already_paid,
        number_of_emis,
        req.params.id,
        current.user_id,
      ]
    );

    const row = await fetchEmiProductWithPaidMonths(result.rows[0].id);

    return success(
      res,
      mapEmiProduct(row),
      "EMI product updated successfully"
    );
  } catch (err) {
    return handleWriteError(err, res, "Error updating EMI product");
  }
});

// Delete — reject if payments still reference this EMI
router.delete("/:id", async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id, user_id, product_name, emi_start_from, already_paid, number_of_emis, created_at
       FROM emi_products
       WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "EMI product not found");
    }

    const requestedUserId = req.query.user_id ?? req.body?.user_id;
    const ownershipError = assertOwnership(existing.rows[0], requestedUserId);
    if (ownershipError) {
      return forbidden(res, ownershipError);
    }

    const linked = await db.query(
      `SELECT 1 FROM payments WHERE emi_product_id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (linked.rows.length > 0) {
      return conflict(
        res,
        "Cannot delete EMI product that is already linked to payments"
      );
    }

    const mapped = mapEmiProduct({
      ...existing.rows[0],
      paid_months: 0,
    });

    await db.query(`DELETE FROM emi_products WHERE id = $1`, [req.params.id]);

    return success(res, mapped, "EMI product deleted successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting EMI product");
  }
});

module.exports = router;
