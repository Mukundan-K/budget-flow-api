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
const {
  calculateDebtAmounts,
  calculateDebtSummary,
} = require("../services/financial");
const {
  getDebtMonthNetForMonth,
  toDebtOverview,
} = require("../services/financial/debtMonth.service");
const {
  yearMonthFromTimestamp,
  rebuildAffectedMonthlyFinancialSummaries,
} = require("../services/financial/monthlyFinancialSummary.service");
const {
  parseTransactionType,
  listOutstandingByPerson,
  getMonthlyDebtActivity,
  listDebtTransactions,
} = require("../services/financial/debtTransactions.service");

/**
 * Transaction types stored in `debts`:
 * - received        = I received money (I owe them)
 * - given           = I gave money (they owe me)
 * - returned_by_me  = I returned money previously received
 * - returned_to_me  = they returned money previously given
 */

const DEBT_TYPE_ERROR =
  "debt_type must be 'received', 'given', 'returned_by_me', or 'returned_to_me'";

function parseDebtType(value) {
  return parseTransactionType(value);
}

function requestedDebtType(body) {
  return body.debt_type ?? body.transaction_type ?? body.type;
}

function mapDebt(row) {
  const amounts = calculateDebtAmounts({
    amount: row.amount,
    returned_amount: row.returned_amount || 0,
  });
  return {
    id: row.id,
    person_id: row.person_id,
    person_name: row.person_name,
    person: row.person_id
      ? {
          id: row.person_id,
          name: row.person_name,
        }
      : undefined,
    amount: amounts.amount,
    returned_amount: amounts.returned_amount,
    net_amount: amounts.net_amount,
    outstanding: amounts.outstanding,
    is_pending_zero: amounts.is_pending_zero,
    has_pending: amounts.has_pending,
    debt_type: row.debt_type,
    transaction_type: row.debt_type,
    date: formatTimestamp(row.debt_date),
    user_id: row.user_id,
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

function parseMonthYearQuery(query) {
  const { month, year } = query;
  const hasMonth = month !== undefined && month !== null && month !== "";
  const hasYear = year !== undefined && year !== null && year !== "";

  if (!hasMonth && !hasYear) {
    return { month: null, year: null };
  }

  const y = hasYear ? Number(year) : new Date().getFullYear();
  if (!Number.isInteger(y) || y < 2000) {
    return { error: "year must be a valid year" };
  }

  if (!hasMonth) {
    return { month: null, year: y };
  }

  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    return { error: "month must be an integer between 1 and 12" };
  }
  return { month: m, year: y };
}

const DEBT_SELECT = `
  SELECT d.id, d.user_id, d.person_id, d.amount, d.debt_type,
         d.debt_date, d.created_at,
         p.name AS person_name,
         0 AS returned_amount
  FROM debts d
  JOIN persons p ON p.id = d.person_id
`;

function debtOriginSummaryTarget(debt) {
  const ym = yearMonthFromTimestamp(debt.debt_date);
  return {
    user_id: debt.user_id,
    year: ym.year,
    month: ym.month,
  };
}

async function fetchMappedDebt(client, debtId) {
  const result = await client.query(`${DEBT_SELECT} WHERE d.id = $1`, [debtId]);
  return result.rows[0] ? mapDebt(result.rows[0]) : null;
}

function validatePayload(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.amount !== undefined) {
    if (body.amount === undefined || body.amount === null || body.amount === "") {
      errors.push("amount is required");
    } else if (parseAmount(body.amount) === null || parseAmount(body.amount) <= 0) {
      errors.push("amount must be a positive number");
    }
  }

  if (!partial || body.person_id !== undefined) {
    if (
      body.person_id === undefined ||
      body.person_id === null ||
      body.person_id === ""
    ) {
      errors.push("person_id is required");
    }
  }

  if (
    !partial ||
    body.debt_type !== undefined ||
    body.transaction_type !== undefined ||
    body.type !== undefined
  ) {
    const type = parseDebtType(requestedDebtType(body));
    if (type === undefined) {
      errors.push(
        "debt_type is required ('received', 'given', 'returned_by_me', or 'returned_to_me')"
      );
    } else if (type === null) {
      errors.push(DEBT_TYPE_ERROR);
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

async function assertPersonForUser(person_id, user_id) {
  const result = await db.query(
    `SELECT id, name, user_id FROM persons WHERE id = $1`,
    [person_id]
  );
  if (result.rows.length === 0) {
    return { error: "person_id is invalid" };
  }
  if (String(result.rows[0].user_id) !== String(user_id)) {
    return { error: "person_id does not belong to this user" };
  }
  return { person: result.rows[0] };
}

// Current outstanding balances — all history, no month/year filter
// GET /api/debts/outstanding?user_id=1
router.get("/outstanding", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const outstanding = await listOutstandingByPerson(user_id);
    return success(
      res,
      outstanding,
      "Outstanding debt by person fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching outstanding debts");
  }
});

// Monthly debt activity (transaction dates in the selected month)
// GET /api/debts/summary?user_id=1&year=2026&month=9
router.get("/summary", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const now = new Date();
    const parsed = parseMonthYearQuery({
      month: req.query.month,
      year: req.query.year ?? now.getFullYear(),
    });
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const summary = await getMonthlyDebtActivity(
      user_id,
      parsed.year,
      parsed.month
    );
    return success(res, summary, "Debt monthly summary fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debt summary");
  }
});

// Unified transaction timeline (origins + returns, each on its own date)
// GET /api/debts/transactions?user_id=1
// GET /api/debts/transactions?user_id=1&person_id=2
// GET /api/debts/transactions?user_id=1&year=2026&month=9
router.get("/transactions", async (req, res) => {
  try {
    const { user_id, person_id } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const parsed = parseMonthYearQuery(req.query);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const items = await listDebtTransactions({
      userId: user_id,
      personId: person_id,
      month: parsed.month,
      year: parsed.year,
    });
    return success(res, items, "Debt transactions fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debt transactions");
  }
});

// Create any of the four transaction types
// POST /api/debts/transactions
router.post("/transactions", async (req, res) => {
  try {
    const user_id = req.body.user_id;
    const person_id = req.body.person_id;
    const transactionType = parseTransactionType(
      req.body.transaction_type ?? req.body.debt_type ?? req.body.type
    );
    const amount = parseAmount(req.body.amount);

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }
    if (!person_id) {
      return badRequest(res, "person_id is required");
    }
    if (transactionType === undefined) {
      return badRequest(
        res,
        "transaction_type is required ('received', 'given', 'returned_by_me', or 'returned_to_me')"
      );
    }
    if (transactionType === null) {
      return badRequest(
        res,
        "transaction_type must be 'received', 'given', 'returned_by_me', or 'returned_to_me'"
      );
    }
    if (amount === null || amount <= 0) {
      return badRequest(res, "amount must be a positive number");
    }
    const dateRaw = req.body.transaction_date ?? req.body.date;
    if (dateRaw !== undefined && dateRaw !== null && dateRaw !== "") {
      if (parseTimestamp(dateRaw) === null) {
        return badRequest(res, "date must be a valid date or timestamp");
      }
    }

    const txnDate = parseTimestamp(dateRaw) || nowTimestamp();
    const personCheck = await assertPersonForUser(person_id, user_id);
    if (personCheck.error) {
      return badRequest(res, personCheck.error);
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, debt_date`,
        [user_id, person_id, formatAmount(amount), transactionType, txnDate]
      );
      await rebuildAffectedMonthlyFinancialSummaries(
        [debtOriginSummaryTarget(inserted.rows[0])],
        client
      );
      const mapped = await fetchMappedDebt(client, inserted.rows[0].id);
      await client.query("COMMIT");

      const messages = {
        received: "Received transaction created successfully",
        given: "Given transaction created successfully",
        returned_by_me: "Returned by me recorded successfully",
        returned_to_me: "Returned to me recorded successfully",
      };
      return created(
        res,
        {
          transaction_type: transactionType,
          debt: mapped,
        },
        messages[transactionType]
      );
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    return serverError(res, "Error creating debt transaction");
  }
});

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
    const givenItems = mapped.filter((d) => d.debt_type === "given");
    const receivedItems = mapped.filter((d) => d.debt_type === "received");

    let summary;
    if (filterMonth != null && filterYear != null) {
      // Same month activity as dashboard remaining balance
      const monthNet = await getDebtMonthNetForMonth(
        user_id,
        filterYear,
        filterMonth
      );
      summary = calculateDebtSummary({
        given_total: monthNet.given_total,
        given_returned: monthNet.given_returned,
        received_total: monthNet.received_total,
        received_returned: monthNet.received_returned,
        received_repaid_this_month: monthNet.received_repaid_this_month,
        received_repaid_past_months: monthNet.received_repaid_past_months,
      });
    } else {
      const sumAmount = (rows) =>
        formatAmount(addAmounts(...rows.map((d) => d.amount)));
      const sumReturned = (rows) =>
        formatAmount(addAmounts(...rows.map((d) => d.returned_amount)));
      summary = calculateDebtSummary({
        given_total: sumAmount(givenItems),
        given_returned: sumReturned(givenItems),
        received_total: sumAmount(receivedItems),
        received_returned: sumReturned(receivedItems),
      });
    }

    const debt_net = summary.debt_net;

    return success(
      res,
      {
        month: filterMonth,
        year: filterYear,
        debt: debt_net,
        debt_net,
        overview: {
          ...toDebtOverview(summary),
          ...(filterMonth != null
            ? {
                received_this_month: summary.received_total,
                given_this_month: summary.given_total,
                returned_by_me_this_month: summary.received_returned,
                returned_to_me_this_month: summary.given_returned,
              }
            : {}),
        },
        given: {
          total: summary.given_total,
          returned: summary.given_returned,
          outstanding: summary.given_outstanding,
          items: givenItems,
        },
        received: {
          total: summary.received_total,
          returned: summary.received_returned,
          outstanding: summary.received_outstanding,
          items: receivedItems,
        },
      },
      "Debt details fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching debt details");
  }
});

// All-time pending given/received per person (not month-filtered)
// GET /api/debts/pending-by-person?user_id=1
router.get("/pending-by-person", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const outstanding = await listOutstandingByPerson(user_id);
    return success(
      res,
      outstanding,
      "Pending debt by person fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching pending debt by person");
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
    const person_id = req.body.person_id;
    const debt_type = parseDebtType(requestedDebtType(req.body));
    const user_id = req.body.user_id;
    const debt_date = parseTimestamp(req.body.date) || nowTimestamp();

    const personCheck = await assertPersonForUser(person_id, user_id);
    if (personCheck.error) {
      return badRequest(res, personCheck.error);
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, debt_date`,
        [user_id, person_id, amount, debt_type, debt_date]
      );

      await rebuildAffectedMonthlyFinancialSummaries(
        [debtOriginSummaryTarget(inserted.rows[0])],
        client
      );

      const mapped = await fetchMappedDebt(client, inserted.rows[0].id);
      await client.query("COMMIT");
      return created(res, mapped, "Debt created successfully");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    return serverError(res, "Error creating debt");
  }
});

// List debts
router.get("/", async (req, res) => {
  try {
    const { user_id, debt_type, type, date, month, year, person_id } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const conditions = ["d.user_id = $1"];
    const params = [user_id];

    const parsedType = parseDebtType(debt_type ?? type);
    if (debt_type !== undefined || type !== undefined) {
      if (!parsedType) {
        return badRequest(res, DEBT_TYPE_ERROR);
      }
      params.push(parsedType);
      conditions.push(`d.debt_type = $${params.length}`);
    }

    if (person_id !== undefined && person_id !== null && person_id !== "") {
      params.push(person_id);
      conditions.push(`d.person_id = $${params.length}`);
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

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return notFound(res, "Debt not found");
    }

    return success(
      res,
      {
        ...mapDebt(result.rows[0]),
        returns: [],
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
    const person_id =
      req.body.person_id !== undefined ? req.body.person_id : current.person_id;
    const debt_type =
      req.body.debt_type !== undefined ||
      req.body.transaction_type !== undefined ||
      req.body.type !== undefined
        ? parseDebtType(requestedDebtType(req.body))
        : current.debt_type;
    const user_id = req.body.user_id ?? current.user_id;
    const debt_date =
      req.body.date !== undefined
        ? parseTimestamp(req.body.date) || nowTimestamp()
        : current.debt_date;

    if (debt_type === null) {
      return badRequest(res, DEBT_TYPE_ERROR);
    }

    const personCheck = await assertPersonForUser(person_id, user_id);
    if (personCheck.error) {
      return badRequest(res, personCheck.error);
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        `SELECT id, user_id, debt_date, debt_type FROM debts WHERE id = $1`,
        [req.params.id]
      );
      if (locked.rows.length === 0) {
        await client.query("ROLLBACK");
        return notFound(res, "Debt not found");
      }

      await client.query(
        `UPDATE debts
         SET user_id = $1,
             person_id = $2,
             amount = $3,
             debt_type = $4,
             debt_date = $5
         WHERE id = $6`,
        [user_id, person_id, amount, debt_type, debt_date, req.params.id]
      );

      const targets = [
        debtOriginSummaryTarget(locked.rows[0]),
        debtOriginSummaryTarget({ user_id, debt_date }),
      ];
      await rebuildAffectedMonthlyFinancialSummaries(targets, client);

      const mapped = await fetchMappedDebt(client, req.params.id);
      await client.query("COMMIT");
      return success(res, mapped, "Debt updated successfully");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating debt");
  }
}

router.put("/:id", (req, res) => updateDebt(req, res, { partial: false }));
router.patch("/:id", (req, res) => updateDebt(req, res, { partial: true }));

// Delete debt
router.delete("/:id", async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`${DEBT_SELECT} WHERE d.id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return notFound(res, "Debt not found");
    }

    await client.query(`DELETE FROM debts WHERE id = $1`, [req.params.id]);
    await rebuildAffectedMonthlyFinancialSummaries(
      [debtOriginSummaryTarget(existing.rows[0])],
      client
    );
    await client.query("COMMIT");

    return success(
      res,
      mapDebt(existing.rows[0]),
      "Debt deleted successfully"
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error(err);
    return serverError(res, "Error deleting debt");
  } finally {
    client.release();
  }
});

module.exports = router;
