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
  calculateDebtNet,
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
  SELECT d.id, d.user_id, d.person_id, d.amount, d.debt_type,
         d.debt_date, d.created_at,
         p.name AS person_name,
         COALESCE(ret.returned_amount, 0) AS returned_amount
  FROM debts d
  JOIN persons p ON p.id = d.person_id
  LEFT JOIN (
    SELECT debt_id, SUM(amount) AS returned_amount
    FROM debt_returns
    GROUP BY debt_id
  ) ret ON ret.debt_id = d.id
`;

function debtOriginSummaryTarget(debt) {
  const ym = yearMonthFromTimestamp(debt.debt_date);
  return {
    user_id: debt.user_id,
    year: ym.year,
    month: ym.month,
  };
}

function debtReturnSummaryTarget(ret) {
  const ym = yearMonthFromTimestamp(ret.return_date);
  return {
    user_id: ret.user_id,
    year: ym.year,
    month: ym.month,
  };
}

async function fetchDebtReturns(client, debtId) {
  const result = await client.query(
    `SELECT id, user_id, return_date FROM debt_returns WHERE debt_id = $1`,
    [debtId]
  );
  return result.rows;
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
        overview: toDebtOverview(summary),
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

    const debts = await db.query(
      `${DEBT_SELECT}
       WHERE d.user_id = $1
       ORDER BY p.name ASC, d.id ASC`,
      [user_id]
    );

    const byPerson = new Map();
    debts.rows.map(mapDebt).forEach((debt) => {
      const key = debt.person_id;
      if (!byPerson.has(key)) {
        byPerson.set(key, {
          person_id: debt.person_id,
          person_name: debt.person_name,
          given_outstanding: 0,
          received_outstanding: 0,
        });
      }
      const row = byPerson.get(key);
      if (debt.debt_type === "given") {
        row.given_outstanding = addAmounts(row.given_outstanding, debt.outstanding);
      } else {
        row.received_outstanding = addAmounts(
          row.received_outstanding,
          debt.outstanding
        );
      }
    });

    const people = [...byPerson.values()]
      .map((row) => {
        const given_outstanding = formatAmount(row.given_outstanding);
        const received_outstanding = formatAmount(row.received_outstanding);
        return {
          person_id: row.person_id,
          person_name: row.person_name,
          given_outstanding,
          received_outstanding,
          net: calculateDebtNet(given_outstanding, received_outstanding),
          has_pending: given_outstanding > 0 || received_outstanding > 0,
        };
      })
      .filter((row) => row.has_pending)
      .sort(
        (a, b) =>
          Math.abs(b.net) - Math.abs(a.net) ||
          String(a.person_name).localeCompare(String(b.person_name))
      );

    const given_outstanding = formatAmount(
      addAmounts(...people.map((p) => p.given_outstanding))
    );
    const received_outstanding = formatAmount(
      addAmounts(...people.map((p) => p.received_outstanding))
    );

    return success(
      res,
      {
        given_outstanding,
        received_outstanding,
        debt_net: calculateDebtNet(given_outstanding, received_outstanding),
        people,
      },
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
    const debt_type = parseDebtType(req.body.debt_type ?? req.body.type);
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
        return badRequest(res, "debt_type must be 'given' or 'received'");
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

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO debt_returns (debt_id, user_id, amount, return_date)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.params.id, user_id, amount, return_date]
      );

      await rebuildAffectedMonthlyFinancialSummaries(
        [debtReturnSummaryTarget(inserted.rows[0])],
        client
      );

      const mappedDebt = await fetchMappedDebt(client, req.params.id);
      await client.query("COMMIT");
      return created(
        res,
        {
          return: mapDebtReturn(inserted.rows[0]),
          debt: mappedDebt,
        },
        "Debt return added successfully"
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
    return serverError(res, "Error adding debt return");
  }
});

// Delete return
router.delete("/:id/returns/:returnId", async (req, res) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `DELETE FROM debt_returns
       WHERE id = $1 AND debt_id = $2
       RETURNING *`,
      [req.params.returnId, req.params.id]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return notFound(res, "Debt return not found");
    }

    await rebuildAffectedMonthlyFinancialSummaries(
      [debtReturnSummaryTarget(result.rows[0])],
      client
    );

    const mappedDebt = await fetchMappedDebt(client, req.params.id);
    await client.query("COMMIT");
    return success(
      res,
      {
        return: mapDebtReturn(result.rows[0]),
        debt: mappedDebt,
      },
      "Debt return deleted successfully"
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    console.error(err);
    return serverError(res, "Error deleting debt return");
  } finally {
    client.release();
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
    const person_id =
      req.body.person_id !== undefined ? req.body.person_id : current.person_id;
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

    const personCheck = await assertPersonForUser(person_id, user_id);
    if (personCheck.error) {
      return badRequest(res, personCheck.error);
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

      const returns =
        locked.rows[0].debt_type !== debt_type
          ? await fetchDebtReturns(client, req.params.id)
          : [];

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
        ...returns.map(debtReturnSummaryTarget),
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

    const returns = await fetchDebtReturns(client, req.params.id);

    await client.query(`DELETE FROM debts WHERE id = $1`, [req.params.id]);
    await rebuildAffectedMonthlyFinancialSummaries(
      [
        debtOriginSummaryTarget(existing.rows[0]),
        ...returns.map(debtReturnSummaryTarget),
      ],
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
