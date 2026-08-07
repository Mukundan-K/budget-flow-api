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
const { parseAmount, formatAmount, addAmounts } = require("../utils/money");
const {
  parseTimestamp,
  formatTimestamp,
  nowTimestamp,
  dayStart,
  dayEnd,
  monthRangeTimestamps,
} = require("../utils/datetime");

/**
 * debt_type:
 * - given    = I lent / gave money to someone
 * - received = debt given to me (I borrowed / they lent me)
 * Returns: against given = they paid me back; against received = I repaid them
 */

function parseDebtType(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "given" || normalized === "give" || normalized === "lent") {
    return "given";
  }
  if (
    normalized === "received" ||
    normalized === "receive" ||
    normalized === "taken" ||
    normalized === "borrowed"
  ) {
    return "received";
  }
  return null;
}

function mapDebt(row) {
  const amount = formatAmount(row.amount);
  const returned_amount = formatAmount(row.returned_amount || 0);
  const net_amount = formatAmount(amount - returned_amount);
  return {
    id: row.id,
    person_name: row.person_name,
    amount,
    returned_amount,
    net_amount,
    outstanding: net_amount,
    debt_type: row.debt_type,
    date: formatTimestamp(row.debt_date),
    user_id: row.user_id,
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

function mapDebtReturn(row) {
  return {
    id: row.id,
    debt_id: row.debt_id,
    user_id: row.user_id,
    amount: formatAmount(row.amount),
    date: formatTimestamp(row.return_date),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

const DEBT_SELECT = `
  SELECT d.id, d.user_id, d.person_name, d.amount, d.debt_type,
         d.debt_date, d.created_at,
         COALESCE(ret.returned_amount, 0) AS returned_amount
  FROM debts d
  LEFT JOIN (
    SELECT debt_id, SUM(amount) AS returned_amount
    FROM debt_returns
    GROUP BY debt_id
  ) ret ON ret.debt_id = d.id
`;

function validatePayload(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.amount !== undefined) {
    if (body.amount === undefined || body.amount === null || body.amount === "") {
      errors.push("amount is required");
    } else if (parseAmount(body.amount) === null || parseAmount(body.amount) <= 0) {
      errors.push("amount must be a positive number");
    }
  }

  if (!partial || body.person_name !== undefined || body.name !== undefined) {
    const name = body.person_name ?? body.name;
    if (!name || String(name).trim() === "") {
      errors.push("person_name is required");
    }
  }

  if (!partial || body.debt_type !== undefined || body.type !== undefined) {
    const type = parseDebtType(body.debt_type ?? body.type);
    if (type === undefined) {
      errors.push("debt_type is required ('given' or 'received')");
    } else if (type === null) {
      errors.push("debt_type must be 'given' or 'received'");
    }
  }

  if (!partial || body.user_id !== undefined) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (body.date !== undefined && body.date !== null && body.date !== "") {
    if (parseTimestamp(body.date) === null) {
      errors.push("date must be a valid date or timestamp");
    }
  }

  return errors;
}

// Details / summary — before /:id
// GET /api/debts/details?user_id=1
// GET /api/debts/details?user_id=1&month=8&year=2026
router.get("/details", async (req, res) => {
  try {
    const { user_id, month, year } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const params = [user_id];
    const conditions = ["d.user_id = $1"];
    let filterMonth = null;
    let filterYear = null;

    if (month !== undefined && month !== null && month !== "") {
      const m = Number(month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return badRequest(res, "month must be an integer between 1 and 12");
      }
      const y =
        year !== undefined && year !== null && year !== ""
          ? Number(year)
          : new Date().getFullYear();
      if (!Number.isInteger(y) || y < 2000) {
        return badRequest(res, "year must be a valid year");
      }
      const range = monthRangeTimestamps(y, m);
      params.push(range.start);
      conditions.push(`d.debt_date >= $${params.length}`);
      params.push(range.end);
      conditions.push(`d.debt_date <= $${params.length}`);
      filterMonth = m;
      filterYear = y;
    } else if (year !== undefined && year !== null && year !== "") {
      return badRequest(res, "month is required when year is provided");
    }

    const debts = await db.query(
      `${DEBT_SELECT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.debt_date DESC, d.id DESC`,
      params
    );

    const mapped = debts.rows.map(mapDebt);
    const given = mapped.filter((d) => d.debt_type === "given");
    const received = mapped.filter((d) => d.debt_type === "received");

    const sumNet = (rows) =>
      formatAmount(addAmounts(...rows.map((d) => d.net_amount)));
    const sumAmount = (rows) =>
      formatAmount(addAmounts(...rows.map((d) => d.amount)));
    const sumReturned = (rows) =>
      formatAmount(addAmounts(...rows.map((d) => d.returned_amount)));

    const given_total = sumAmount(given);
    const given_returned = sumReturned(given);
    const given_outstanding = sumNet(given);
    const received_total = sumAmount(received);
    const received_returned = sumReturned(received);
    const received_outstanding = sumNet(received);

    // Net debt for balance: given outstanding − received outstanding
    const debt_net = formatAmount(given_outstanding - received_outstanding);

    return success(
      res,
      {
        month: filterMonth,
        year: filterYear,
        debt: debt_net,
        debt_net,
        given: {
          total: given_total,
          returned: given_returned,
          outstanding: given_outstanding,
          items: given,
        },
        received: {
          total: received_total,
          returned: received_returned,
          outstanding: received_outstanding,
          items: received,
        },
      },
      "Debt details fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debt details");
  }
});

// Create debt
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const amount = formatAmount(req.body.amount);
    const person_name = String(req.body.person_name ?? req.body.name).trim();
    const debt_type = parseDebtType(req.body.debt_type ?? req.body.type);
    const user_id = req.body.user_id;
    const debt_date = parseTimestamp(req.body.date) || nowTimestamp();

    const inserted = await db.query(
      `INSERT INTO debts (user_id, person_name, amount, debt_type, debt_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user_id, person_name, amount, debt_type, debt_date]
    );

    const result = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      inserted.rows[0].id,
    ]);

    return created(res, mapDebt(result.rows[0]), "Debt created successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error creating debt");
  }
});

// List debts
router.get("/", async (req, res) => {
  try {
    const { user_id, debt_type, type, date, month, year } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const conditions = ["d.user_id = $1"];
    const params = [user_id];

    const parsedType = parseDebtType(debt_type ?? type);
    if (debt_type !== undefined || type !== undefined) {
      if (!parsedType) {
        return badRequest(res, "debt_type must be 'given' or 'received'");
      }
      params.push(parsedType);
      conditions.push(`d.debt_type = $${params.length}`);
    }

    if (date) {
      const start = dayStart(date);
      const end = dayEnd(date);
      if (!start || !end) {
        return badRequest(res, "date must be a valid date or timestamp");
      }
      params.push(start);
      conditions.push(`d.debt_date >= $${params.length}`);
      params.push(end);
      conditions.push(`d.debt_date <= $${params.length}`);
    } else if (month !== undefined && month !== null && month !== "") {
      const m = Number(month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return badRequest(res, "month must be an integer between 1 and 12");
      }
      const y =
        year !== undefined && year !== null && year !== ""
          ? Number(year)
          : new Date().getFullYear();
      const range = monthRangeTimestamps(y, m);
      params.push(range.start);
      conditions.push(`d.debt_date >= $${params.length}`);
      params.push(range.end);
      conditions.push(`d.debt_date <= $${params.length}`);
    }

    const result = await db.query(
      `${DEBT_SELECT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.debt_date DESC, d.id DESC`,
      params
    );

    return success(
      res,
      result.rows.map(mapDebt),
      "Debts fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debts");
  }
});

// List returns for a debt
router.get("/:id/returns", async (req, res) => {
  try {
    const debt = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);
    if (debt.rows.length === 0) {
      return notFound(res, "Debt not found");
    }

    const returns = await db.query(
      `SELECT * FROM debt_returns
       WHERE debt_id = $1
       ORDER BY return_date DESC, id DESC`,
      [req.params.id]
    );

    return success(
      res,
      {
        debt: mapDebt(debt.rows[0]),
        returns: returns.rows.map(mapDebtReturn),
      },
      "Debt returns fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debt returns");
  }
});

// Add return (for given = they paid me back; for received = I repaid)
router.post("/:id/returns", async (req, res) => {
  try {
    const debt = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);
    if (debt.rows.length === 0) {
      return notFound(res, "Debt not found");
    }

    const amount = parseAmount(req.body.amount);
    if (amount === null || amount <= 0) {
      return badRequest(res, "amount must be a positive number");
    }

    const user_id = req.body.user_id ?? debt.rows[0].user_id;
    if (String(user_id) !== String(debt.rows[0].user_id)) {
      return badRequest(res, "user_id does not match debt owner");
    }

    if (req.body.date !== undefined && req.body.date !== null && req.body.date !== "") {
      if (parseTimestamp(req.body.date) === null) {
        return badRequest(res, "date must be a valid date or timestamp");
      }
    }
    const return_date = parseTimestamp(req.body.date) || nowTimestamp();

    const remaining = formatAmount(
      formatAmount(debt.rows[0].amount) -
        formatAmount(debt.rows[0].returned_amount || 0)
    );
    if (amount > remaining) {
      return badRequest(
        res,
        `return amount exceeds remaining debt amount (available: ${remaining})`
      );
    }

    const inserted = await db.query(
      `INSERT INTO debt_returns (debt_id, user_id, amount, return_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, user_id, amount, return_date]
    );

    const updated = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);

    return created(
      res,
      {
        return: mapDebtReturn(inserted.rows[0]),
        debt: mapDebt(updated.rows[0]),
      },
      "Debt return added successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error adding debt return");
  }
});

// Delete return
router.delete("/:id/returns/:returnId", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM debt_returns
       WHERE id = $1 AND debt_id = $2
       RETURNING *`,
      [req.params.returnId, req.params.id]
    );
    if (result.rows.length === 0) {
      return notFound(res, "Debt return not found");
    }

    const debt = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);

    return success(
      res,
      {
        return: mapDebtReturn(result.rows[0]),
        debt: debt.rows[0] ? mapDebt(debt.rows[0]) : null,
      },
      "Debt return deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting debt return");
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return notFound(res, "Debt not found");
    }

    const returns = await db.query(
      `SELECT * FROM debt_returns
       WHERE debt_id = $1
       ORDER BY return_date DESC, id DESC`,
      [req.params.id]
    );

    return success(
      res,
      {
        ...mapDebt(result.rows[0]),
        returns: returns.rows.map(mapDebtReturn),
      },
      "Debt fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debt");
  }
});

async function updateDebt(req, res, { partial = false } = {}) {
  try {
    const existing = await db.query(`SELECT * FROM debts WHERE id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      return notFound(res, "Debt not found");
    }

    const errors = validatePayload(req.body, { partial });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const amount =
      req.body.amount !== undefined
        ? formatAmount(req.body.amount)
        : formatAmount(current.amount);
    const person_name =
      req.body.person_name !== undefined || req.body.name !== undefined
        ? String(req.body.person_name ?? req.body.name).trim()
        : current.person_name;
    const debt_type =
      req.body.debt_type !== undefined || req.body.type !== undefined
        ? parseDebtType(req.body.debt_type ?? req.body.type)
        : current.debt_type;
    const user_id = req.body.user_id ?? current.user_id;
    const debt_date =
      req.body.date !== undefined
        ? parseTimestamp(req.body.date) || nowTimestamp()
        : current.debt_date;

    if (debt_type === null) {
      return badRequest(res, "debt_type must be 'given' or 'received'");
    }

    const returned = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS returned_amount
       FROM debt_returns WHERE debt_id = $1`,
      [req.params.id]
    );
    const alreadyReturned = formatAmount(returned.rows[0].returned_amount);
    if (amount < alreadyReturned) {
      return badRequest(
        res,
        `amount cannot be less than already returned amount (${alreadyReturned})`
      );
    }

    await db.query(
      `UPDATE debts
       SET user_id = $1,
           person_name = $2,
           amount = $3,
           debt_type = $4,
           debt_date = $5
       WHERE id = $6`,
      [user_id, person_name, amount, debt_type, debt_date, req.params.id]
    );

    const result = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);

    return success(res, mapDebt(result.rows[0]), "Debt updated successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating debt");
  }
}

router.put("/:id", (req, res) => updateDebt(req, res, { partial: false }));
router.patch("/:id", (req, res) => updateDebt(req, res, { partial: true }));

// Delete debt
router.delete("/:id", async (req, res) => {
  try {
    const existing = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      return notFound(res, "Debt not found");
    }

    await db.query(`DELETE FROM debts WHERE id = $1`, [req.params.id]);

    return success(
      res,
      mapDebt(existing.rows[0]),
      "Debt deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting debt");
  }
});

module.exports = router;
