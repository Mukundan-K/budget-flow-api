const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  created,
  badRequest,
  notFound,
  serverError,
} = require("../utils/response");

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function toAmount(value) {
  const amount = Number(value);
  if (Number.isNaN(amount)) return null;
  return Math.round(amount * 100) / 100;
}

function toDateOnly(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mapPayment(row) {
  return {
    id: row.id,
    amount: toAmount(row.amount),
    date: row.payment_date
      ? new Date(row.payment_date).toISOString().slice(0, 10)
      : row.payment_date,
    user_id: row.user_id,
    payment_type_id: row.payment_type_id,
    payment_type: row.payment_type_name
      ? {
          id: row.payment_type_id,
          name: row.payment_type_name,
          is_income: Boolean(row.payment_type_is_income),
        }
      : undefined,
    created_at: row.created_at,
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
    if (toDateOnly(body.date) === null) {
      errors.push("date must be a valid date (YYYY-MM-DD)");
    }
  }

  return errors;
}

const PAYMENT_SELECT = `
  SELECT p.id, p.amount, p.payment_date, p.user_id, p.payment_type_id, p.created_at,
         pt.name AS payment_type_name, pt.is_income AS payment_type_is_income
  FROM payments p
  JOIN payment_types pt ON pt.id = p.payment_type_id
`;

// Create payment (salary, rent, etc.)
router.post("/", async (req, res) => {
  try {
    const errors = validatePaymentPayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const typeCheck = await db.query(
      `SELECT id FROM payment_types WHERE id = $1`,
      [req.body.payment_type_id]
    );
    if (typeCheck.rows.length === 0) {
      return badRequest(res, "payment_type_id is invalid");
    }

    const amount = toAmount(req.body.amount);
    const user_id = req.body.user_id;
    const payment_type_id = req.body.payment_type_id;
    const payment_date = toDateOnly(req.body.date) || todayDate();

    const result = await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [amount, payment_date, user_id, payment_type_id]
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
router.get("/", async (req, res) => {
  try {
    const { user_id, payment_type_id, date } = req.query;
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
    if (date) {
      const paymentDate = toDateOnly(date);
      if (!paymentDate) {
        return badRequest(res, "date must be a valid date (YYYY-MM-DD)");
      }
      params.push(paymentDate);
      conditions.push(`p.payment_date = $${params.length}`);
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

    return success(res, mapPayment(result.rows[0]), "Payment fetched successfully");
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
      `SELECT id FROM payment_types WHERE id = $1`,
      [req.body.payment_type_id]
    );
    if (typeCheck.rows.length === 0) {
      return badRequest(res, "payment_type_id is invalid");
    }

    const amount = toAmount(req.body.amount);
    const user_id = req.body.user_id;
    const payment_type_id = req.body.payment_type_id;
    const payment_date = toDateOnly(req.body.date) || todayDate();

    const result = await db.query(
      `UPDATE payments
       SET amount = $1,
           payment_date = $2,
           user_id = $3,
           payment_type_id = $4
       WHERE id = $5
       RETURNING id`,
      [amount, payment_date, user_id, payment_type_id, req.params.id]
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
      `SELECT id, amount, payment_date, user_id, payment_type_id
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
        ? toDateOnly(req.body.date) || todayDate()
        : toDateOnly(current.payment_date) || todayDate();
    const user_id = req.body.user_id ?? current.user_id;
    const payment_type_id = req.body.payment_type_id ?? current.payment_type_id;

    if (req.body.payment_type_id !== undefined) {
      const typeCheck = await db.query(
        `SELECT id FROM payment_types WHERE id = $1`,
        [payment_type_id]
      );
      if (typeCheck.rows.length === 0) {
        return badRequest(res, "payment_type_id is invalid");
      }
    }

    await db.query(
      `UPDATE payments
       SET amount = $1,
           payment_date = $2,
           user_id = $3,
           payment_type_id = $4
       WHERE id = $5`,
      [amount, payment_date, user_id, payment_type_id, req.params.id]
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
