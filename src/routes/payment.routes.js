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
const { parseAmount, formatAmount } = require("../utils/money");
const { isValidMonth } = require("../masters/month.master");
const { isValidYear } = require("../masters/year.master");
const {
  nowTimestamp,
  parseTimestamp,
  formatTimestamp,
  dayStart,
  dayEnd,
  monthRangeTimestamps,
} = require("../utils/datetime");

const VALID_FILTERS = new Set(["day", "month", "year"]);

/**
 * Resolve inclusive date range for payment list filters.
 * - filter=day|date     → that day
 * - filter=month|month  → that month (year defaults to current)
 * - filter=year|year    → full year
 */
function resolvePaymentFilterRange({ filter, date, month, year }) {
  const currentYear = new Date().getFullYear();
  const hasDate = date !== undefined && date !== null && date !== "";
  const hasMonth = month !== undefined && month !== null && month !== "";
  const hasYear = year !== undefined && year !== null && year !== "";

  let effectiveFilter = filter || null;
  if (!effectiveFilter) {
    if (hasDate) effectiveFilter = "day";
    else if (hasMonth) effectiveFilter = "month";
    else if (hasYear) effectiveFilter = "year";
  }

  if (!effectiveFilter) return null;

  if (!VALID_FILTERS.has(effectiveFilter)) {
    return { error: "filter must be one of: day, month, year" };
  }

  if (effectiveFilter === "day") {
    if (!hasDate) {
      return { error: "date is required for day filter" };
    }
    const start = dayStart(date);
    const end = dayEnd(date);
    if (!start || !end) {
      return { error: "date must be a valid date or timestamp" };
    }
    return { start, end, mode: "day" };
  }

  if (effectiveFilter === "month") {
    if (!hasMonth) {
      return { error: "month is required for month filter (1-12)" };
    }
    if (!isValidMonth(month)) {
      return { error: "month must be an integer between 1 and 12" };
    }
    const selectedYear = hasYear ? Number(year) : currentYear;
    if (!isValidYear(selectedYear)) {
      return { error: "year must be a valid year from the years master" };
    }
    return {
      ...monthRangeTimestamps(selectedYear, Number(month)),
      mode: "month",
      month: Number(month),
      year: selectedYear,
    };
  }

  // year
  if (!hasYear) {
    return { error: "year is required for year filter" };
  }
  if (!isValidYear(year)) {
    return { error: "year must be a valid year from the years master" };
  }
  const y = Number(year);
  const jan = monthRangeTimestamps(y, 1);
  const dec = monthRangeTimestamps(y, 12);
  return { start: jan.start, end: dec.end, mode: "year", year: y };
}

function toAmount(value) {
  return parseAmount(value);
}

function isEmiType(typeRow) {
  return typeRow && String(typeRow.name).trim().toLowerCase() === "emi";
}

function mapEmiProduct(row) {
  if (!row || !row.emi_product_id) return null;
  return {
    id: row.emi_product_id,
    product_name: row.emi_product_name,
    start_date: formatTimestamp(row.emi_start_from),
    already_paid: row.already_paid != null ? Number(row.already_paid) : 0,
    number_of_emis: row.number_of_emis != null ? Number(row.number_of_emis) : null,
  };
}

function mapPayment(row) {
  const amount = formatAmount(row.amount);
  const returned_amount = formatAmount(row.returned_amount || 0);
  const net_amount = formatAmount(amount - returned_amount);
  return {
    id: row.id,
    amount,
    returned_amount,
    net_amount,
    my_contribution: net_amount,
    date: formatTimestamp(row.payment_date),
    user_id: row.user_id,
    payment_type_id: row.payment_type_id,
    payment_type: row.payment_type_name
      ? {
          id: row.payment_type_id,
          name: row.payment_type_name,
          is_income: Boolean(row.payment_type_is_income),
        }
      : undefined,
    emi_product_id: row.emi_product_id || null,
    product_name: row.emi_product_name || null,
    emi: mapEmiProduct(row),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

function mapPaymentReturn(row) {
  return {
    id: row.id,
    payment_id: row.payment_id,
    user_id: row.user_id,
    amount: formatAmount(row.amount),
    date: formatTimestamp(row.return_date),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

function validatePaymentPayload(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.amount !== undefined) {
    if (body.amount === undefined || body.amount === null || body.amount === "") {
      errors.push("amount is required");
    } else if (toAmount(body.amount) === null || toAmount(body.amount) <= 0) {
      errors.push("amount must be a positive number");
    }
  }

  if (!partial || body.user_id !== undefined) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (!partial || body.payment_type_id !== undefined) {
    if (
      body.payment_type_id === undefined ||
      body.payment_type_id === null ||
      body.payment_type_id === ""
    ) {
      errors.push("payment_type_id is required");
    }
  }

  if (body.date !== undefined && body.date !== null && body.date !== "") {
    if (parseTimestamp(body.date) === null) {
      errors.push("date must be a valid date or timestamp");
    }
  }

  return errors;
}

function validateEmiPayload(emi) {
  const errors = [];

  if (!emi || typeof emi !== "object") {
    return ["emi details are required for EMI payments"];
  }

  const mode = String(emi.mode || "").trim().toLowerCase();
  if (mode !== "existing" && mode !== "new") {
    errors.push("emi.mode must be 'existing' or 'new'");
    return errors;
  }

  if (mode === "existing") {
    if (
      emi.emi_product_id === undefined ||
      emi.emi_product_id === null ||
      emi.emi_product_id === ""
    ) {
      errors.push("emi.emi_product_id is required for existing EMI");
    }
  }

  if (mode === "new") {
    if (!emi.product_name || String(emi.product_name).trim() === "") {
      errors.push("emi.product_name is required for new EMI");
    }

    const startDate = emi.start_date || emi.emi_start_from;
    if (!startDate) {
      errors.push("emi.start_date is required for new EMI");
    } else if (parseTimestamp(startDate) === null) {
      errors.push("emi.start_date must be a valid date or timestamp");
    }

    const count = Number(emi.number_of_emis);
    if (
      emi.number_of_emis === undefined ||
      emi.number_of_emis === null ||
      emi.number_of_emis === ""
    ) {
      errors.push("emi.number_of_emis is required for new EMI");
    } else if (!Number.isInteger(count) || count <= 0) {
      errors.push("emi.number_of_emis must be a positive integer");
    }

    if (
      emi.already_paid === undefined ||
      emi.already_paid === null ||
      emi.already_paid === ""
    ) {
      errors.push("emi.already_paid is required for new EMI");
    } else {
      const paid = Number(emi.already_paid);
      if (!Number.isInteger(paid) || paid < 0) {
        errors.push("emi.already_paid must be an integer >= 0");
      } else if (Number.isInteger(count) && count > 0 && paid > count) {
        errors.push("emi.already_paid cannot be greater than number_of_emis");
      }
    }
  }

  return errors;
}

async function resolveEmiProductId(userId, emi) {
  const mode = String(emi.mode).trim().toLowerCase();

  if (mode === "existing") {
    const existing = await db.query(
      `SELECT id FROM emi_products
       WHERE id = $1 AND user_id = $2`,
      [emi.emi_product_id, userId]
    );
    if (existing.rows.length === 0) {
      return { error: "emi_product_id is invalid for this user" };
    }
    return { emi_product_id: existing.rows[0].id };
  }

  const product_name = String(emi.product_name).trim();
  const emi_start_from = parseTimestamp(emi.start_date || emi.emi_start_from);
  const number_of_emis = Number(emi.number_of_emis);
  const already_paid = Number(emi.already_paid);

  try {
    const createdProduct = await db.query(
      `INSERT INTO emi_products
         (user_id, product_name, emi_start_from, already_paid, number_of_emis)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, product_name, emi_start_from, already_paid, number_of_emis]
    );
    return { emi_product_id: createdProduct.rows[0].id };
  } catch (err) {
    if (err.code === "23505") {
      return {
        error: "EMI product with this name already exists for the user",
      };
    }
    throw err;
  }
}

const PAYMENT_SELECT = `
  SELECT p.id, p.amount, p.payment_date, p.user_id, p.payment_type_id,
         p.emi_product_id, p.created_at,
         pt.name AS payment_type_name, pt.is_income AS payment_type_is_income,
         ep.product_name AS emi_product_name,
         ep.emi_start_from,
         ep.already_paid,
         ep.number_of_emis,
         COALESCE(ret.returned_amount, 0) AS returned_amount
  FROM payments p
  JOIN payment_types pt ON pt.id = p.payment_type_id
  LEFT JOIN emi_products ep ON ep.id = p.emi_product_id
  LEFT JOIN (
    SELECT payment_id, SUM(amount) AS returned_amount
    FROM payment_returns
    GROUP BY payment_id
  ) ret ON ret.payment_id = p.id
`;

// Create payment (salary, rent, EMI, etc.)
router.post("/", async (req, res) => {
  try {
    const errors = validatePaymentPayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const typeCheck = await db.query(
      `SELECT id, name, is_income FROM payment_types WHERE id = $1`,
      [req.body.payment_type_id]
    );
    if (typeCheck.rows.length === 0) {
      return badRequest(res, "payment_type_id is invalid");
    }

    const paymentType = typeCheck.rows[0];
    let emi_product_id = null;

    if (isEmiType(paymentType)) {
      const emiErrors = validateEmiPayload(req.body.emi);
      if (emiErrors.length) {
        return badRequest(res, emiErrors.join(", "));
      }

      const resolved = await resolveEmiProductId(req.body.user_id, req.body.emi);
      if (resolved.error) {
        if (resolved.error.includes("already exists")) {
          return conflict(res, resolved.error);
        }
        return badRequest(res, resolved.error);
      }
      emi_product_id = resolved.emi_product_id;
    }

    const amount = toAmount(req.body.amount);
    const user_id = req.body.user_id;
    const payment_type_id = req.body.payment_type_id;
    const payment_date = parseTimestamp(req.body.date) || nowTimestamp();

    const result = await db.query(
      `INSERT INTO payments
         (amount, payment_date, user_id, payment_type_id, emi_product_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [amount, payment_date, user_id, payment_type_id, emi_product_id]
    );

    const createdPayment = await db.query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [result.rows[0].id]
    );

    return created(
      res,
      mapPayment(createdPayment.rows[0]),
      "Payment added successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error adding payment");
  }
});

// List payments
// GET /api/payments?user_id=2&month=8&year=2026
// GET /api/payments?user_id=2&year=2026
// GET /api/payments?user_id=2&filter=month&month=8&year=2026
// GET /api/payments?user_id=2&filter=year&year=2026
// GET /api/payments?user_id=2&filter=day&date=2026-08-08
router.get("/", async (req, res) => {
  try {
    const { user_id, payment_type_id, filter, date, month, year } = req.query;
    const conditions = [];
    const params = [];

    if (user_id) {
      params.push(user_id);
      conditions.push(`p.user_id = $${params.length}`);
    }
    if (payment_type_id) {
      params.push(payment_type_id);
      conditions.push(`p.payment_type_id = $${params.length}`);
    }

    const range = resolvePaymentFilterRange({ filter, date, month, year });
    if (range && range.error) {
      return badRequest(res, range.error);
    }
    if (range) {
      params.push(range.start);
      conditions.push(`p.payment_date >= $${params.length}`);
      params.push(range.end);
      conditions.push(`p.payment_date <= $${params.length}`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const result = await db.query(
      `${PAYMENT_SELECT}
       ${whereClause}
       ORDER BY p.payment_date DESC, p.id DESC`,
      params
    );

    return success(
      res,
      result.rows.map(mapPayment),
      "Payments fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching payments");
  }
});

// List returns for a payment
router.get("/:id/returns", async (req, res) => {
  try {
    const payment = await db.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [
      req.params.id,
    ]);
    if (payment.rows.length === 0) {
      return notFound(res, "Payment not found");
    }

    const result = await db.query(
      `SELECT * FROM payment_returns
       WHERE payment_id = $1
       ORDER BY return_date DESC, id DESC`,
      [req.params.id]
    );

    return success(
      res,
      {
        payment: mapPayment(payment.rows[0]),
        returns: result.rows.map(mapPaymentReturn),
      },
      "Payment returns fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching payment returns");
  }
});

// Add return against a payment
router.post("/:id/returns", async (req, res) => {
  try {
    const payment = await db.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [
      req.params.id,
    ]);
    if (payment.rows.length === 0) {
      return notFound(res, "Payment not found");
    }

    const amount = toAmount(req.body.amount);
    if (amount === null || amount <= 0) {
      return badRequest(res, "amount must be a positive number");
    }

    const user_id = req.body.user_id ?? payment.rows[0].user_id;
    if (String(user_id) !== String(payment.rows[0].user_id)) {
      return badRequest(res, "user_id does not match payment owner");
    }

    if (req.body.date !== undefined && req.body.date !== null && req.body.date !== "") {
      if (parseTimestamp(req.body.date) === null) {
        return badRequest(res, "date must be a valid date or timestamp");
      }
    }
    const return_date = parseTimestamp(req.body.date) || nowTimestamp();

    const paymentAmount = formatAmount(payment.rows[0].amount);
    const alreadyReturned = formatAmount(payment.rows[0].returned_amount || 0);
    const remaining = formatAmount(paymentAmount - alreadyReturned);

    if (amount > remaining) {
      return badRequest(
        res,
        `return amount exceeds remaining payment amount (available: ${remaining})`
      );
    }

    const inserted = await db.query(
      `INSERT INTO payment_returns (payment_id, user_id, amount, return_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, user_id, amount, return_date]
    );

    const updatedPayment = await db.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [
      req.params.id,
    ]);

    return created(
      res,
      {
        return: mapPaymentReturn(inserted.rows[0]),
        payment: mapPayment(updatedPayment.rows[0]),
      },
      "Payment return added successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error adding payment return");
  }
});

// Delete a payment return
router.delete("/:id/returns/:returnId", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM payment_returns
       WHERE id = $1 AND payment_id = $2
       RETURNING *`,
      [req.params.returnId, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Payment return not found");
    }

    const payment = await db.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [
      req.params.id,
    ]);

    return success(
      res,
      {
        return: mapPaymentReturn(result.rows[0]),
        payment: payment.rows[0] ? mapPayment(payment.rows[0]) : null,
      },
      "Payment return deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting payment return");
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Payment not found");
    }

    const returns = await db.query(
      `SELECT * FROM payment_returns
       WHERE payment_id = $1
       ORDER BY return_date DESC, id DESC`,
      [req.params.id]
    );

    return success(
      res,
      {
        ...mapPayment(result.rows[0]),
        returns: returns.rows.map(mapPaymentReturn),
      },
      "Payment fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching payment");
  }
});

// Update
router.put("/:id", async (req, res) => {
  try {
    const errors = validatePaymentPayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const typeCheck = await db.query(
      `SELECT id, name, is_income FROM payment_types WHERE id = $1`,
      [req.body.payment_type_id]
    );
    if (typeCheck.rows.length === 0) {
      return badRequest(res, "payment_type_id is invalid");
    }

    const paymentType = typeCheck.rows[0];
    let emi_product_id = null;

    if (isEmiType(paymentType)) {
      const emiErrors = validateEmiPayload(req.body.emi);
      if (emiErrors.length) {
        return badRequest(res, emiErrors.join(", "));
      }

      const resolved = await resolveEmiProductId(req.body.user_id, req.body.emi);
      if (resolved.error) {
        if (resolved.error.includes("already exists")) {
          return conflict(res, resolved.error);
        }
        return badRequest(res, resolved.error);
      }
      emi_product_id = resolved.emi_product_id;
    }

    const amount = toAmount(req.body.amount);
    const user_id = req.body.user_id;
    const payment_type_id = req.body.payment_type_id;
    const payment_date = parseTimestamp(req.body.date) || nowTimestamp();

    const result = await db.query(
      `UPDATE payments
       SET amount = $1,
           payment_date = $2,
           user_id = $3,
           payment_type_id = $4,
           emi_product_id = $5
       WHERE id = $6
       RETURNING id`,
      [amount, payment_date, user_id, payment_type_id, emi_product_id, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Payment not found");
    }

    const updated = await db.query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [req.params.id]
    );

    return success(res, mapPayment(updated.rows[0]), "Payment updated successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating payment");
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const existing = await db.query(
      `SELECT id, amount, payment_date, user_id, payment_type_id, emi_product_id
       FROM payments WHERE id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "Payment not found");
    }

    const errors = validatePaymentPayload(req.body, { partial: true });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const amount =
      req.body.amount !== undefined
        ? toAmount(req.body.amount)
        : toAmount(current.amount);
    const payment_date =
      req.body.date !== undefined
        ? parseTimestamp(req.body.date) || nowTimestamp()
        : parseTimestamp(current.payment_date) || nowTimestamp();
    const user_id = req.body.user_id ?? current.user_id;
    const payment_type_id = req.body.payment_type_id ?? current.payment_type_id;
    let emi_product_id = current.emi_product_id;

    const typeCheck = await db.query(
      `SELECT id, name, is_income FROM payment_types WHERE id = $1`,
      [payment_type_id]
    );
    if (typeCheck.rows.length === 0) {
      return badRequest(res, "payment_type_id is invalid");
    }

    const paymentType = typeCheck.rows[0];
    if (isEmiType(paymentType) && req.body.emi !== undefined) {
      const emiErrors = validateEmiPayload(req.body.emi);
      if (emiErrors.length) {
        return badRequest(res, emiErrors.join(", "));
      }
      const resolved = await resolveEmiProductId(user_id, req.body.emi);
      if (resolved.error) {
        if (resolved.error.includes("already exists")) {
          return conflict(res, resolved.error);
        }
        return badRequest(res, resolved.error);
      }
      emi_product_id = resolved.emi_product_id;
    } else if (!isEmiType(paymentType)) {
      emi_product_id = null;
    }

    await db.query(
      `UPDATE payments
       SET amount = $1,
           payment_date = $2,
           user_id = $3,
           payment_type_id = $4,
           emi_product_id = $5
       WHERE id = $6`,
      [amount, payment_date, user_id, payment_type_id, emi_product_id, req.params.id]
    );

    const updated = await db.query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [req.params.id]
    );

    return success(res, mapPayment(updated.rows[0]), "Payment updated successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating payment");
  }
});

// Delete
router.delete("/:id", async (req, res) => {
  try {
    const existing = await db.query(
      `${PAYMENT_SELECT} WHERE p.id = $1`,
      [req.params.id]
    );

    if (existing.rows.length === 0) {
      return notFound(res, "Payment not found");
    }

    await db.query(`DELETE FROM payments WHERE id = $1`, [req.params.id]);

    return success(
      res,
      mapPayment(existing.rows[0]),
      "Payment deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting payment");
  }
});

module.exports = router;
