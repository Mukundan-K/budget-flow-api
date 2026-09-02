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
const { calculateSavingsNet, calculateSavingsAmounts } = require("../services/financial");

function parseTransactionType(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "credit" || normalized === "c") return "credit";
  if (normalized === "debit" || normalized === "d") return "debit";
  return null;
}

function mapSaving(row) {
  return {
    id: row.id,
    amount: formatAmount(row.amount),
    transaction_type: row.transaction_type,
    date: formatTimestamp(row.transaction_date),
    user_id: row.user_id,
    bank_account_id: row.bank_account_id,
    bank_account: row.bank_account_name
      ? {
          id: row.bank_account_id,
          name: row.bank_account_name,
        }
      : undefined,
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

const SAVING_SELECT = `
  SELECT s.id, s.amount, s.transaction_type, s.transaction_date,
         s.user_id, s.bank_account_id, s.created_at,
         b.name AS bank_account_name
  FROM savings_transactions s
  JOIN bank_accounts b ON b.id = s.bank_account_id
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

  if (!partial || body.transaction_type !== undefined || body.type !== undefined) {
    const type = parseTransactionType(body.transaction_type ?? body.type);
    if (type === undefined) {
      errors.push("transaction_type is required (credit or debit)");
    } else if (type === null) {
      errors.push("transaction_type must be 'credit' or 'debit'");
    }
  }

  if (!partial || body.user_id !== undefined) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === "") {
      errors.push("user_id is required");
    }
  }

  if (!partial || body.bank_account_id !== undefined) {
    if (
      body.bank_account_id === undefined ||
      body.bank_account_id === null ||
      body.bank_account_id === ""
    ) {
      errors.push("bank_account_id is required");
    }
  }

  if (body.date !== undefined && body.date !== null && body.date !== "") {
    if (parseTimestamp(body.date) === null) {
      errors.push("date must be a valid date or timestamp");
    }
  }

  return errors;
}

async function getBankBalance(clientOrDb, bankAccountId, excludeTxnId = null) {
  const params = [bankAccountId];
  let excludeClause = "";
  if (excludeTxnId != null) {
    params.push(excludeTxnId);
    excludeClause = `AND id <> $${params.length}`;
  }

  const result = await clientOrDb.query(
    `SELECT
       COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) AS credited,
       COALESCE(SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END), 0) AS debited
     FROM savings_transactions
     WHERE bank_account_id = $1
       ${excludeClause}`,
    params
  );

  const credited = formatAmount(result.rows[0].credited);
  const debited = formatAmount(result.rows[0].debited);
  return {
    credited,
    debited,
    balance: calculateSavingsNet(credited, debited),
  };
}

async function assertBankBelongsToUser(bankAccountId, userId) {
  const result = await db.query(
    `SELECT id, user_id, name, is_active
     FROM bank_accounts
     WHERE id = $1`,
    [bankAccountId]
  );
  if (result.rows.length === 0) {
    return { error: "bank_account_id is invalid" };
  }
  if (String(result.rows[0].user_id) !== String(userId)) {
    return { error: "bank_account_id does not belong to this user" };
  }
  if (!result.rows[0].is_active) {
    return { error: "bank account is inactive" };
  }
  return { bank: result.rows[0] };
}

async function assertDebitAllowed(bankAccountId, debitAmount, excludeTxnId = null) {
  const { balance } = await getBankBalance(db, bankAccountId, excludeTxnId);
  if (formatAmount(debitAmount) > balance) {
    return {
      error: `insufficient savings balance in this bank account (available: ${balance})`,
    };
  }
  return {};
}

// Details / summary — must be before /:id
// GET /api/savings/details?user_id=1
// GET /api/savings/details?user_id=1&month=8&year=2026
router.get("/details", async (req, res) => {
  try {
    const { user_id, month, year } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const params = [user_id];
    let dateJoinClause = "s.bank_account_id = b.id AND s.user_id = b.user_id";
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
      params.push(range.end);
      dateJoinClause += ` AND s.transaction_date >= $2 AND s.transaction_date <= $3`;
      filterMonth = m;
      filterYear = y;
    } else if (year !== undefined && year !== null && year !== "") {
      return badRequest(res, "month is required when year is provided");
    }

    const banks = await db.query(
      `SELECT
         b.id,
         b.name,
         b.is_active,
         COALESCE(SUM(CASE WHEN s.transaction_type = 'credit' THEN s.amount ELSE 0 END), 0) AS amount_saved,
         COALESCE(SUM(CASE WHEN s.transaction_type = 'debit' THEN s.amount ELSE 0 END), 0) AS amount_debited
       FROM bank_accounts b
       LEFT JOIN savings_transactions s
         ON ${dateJoinClause}
       WHERE b.user_id = $1
       GROUP BY b.id
       ORDER BY b.name ASC`,
      params
    );

    // Lifetime balances (always all-time, for available savings display)
    const lifetime = await db.query(
      `SELECT
         b.id,
         COALESCE(SUM(CASE WHEN s.transaction_type = 'credit' THEN s.amount ELSE 0 END), 0) AS credited,
         COALESCE(SUM(CASE WHEN s.transaction_type = 'debit' THEN s.amount ELSE 0 END), 0) AS debited
       FROM bank_accounts b
       LEFT JOIN savings_transactions s
         ON s.bank_account_id = b.id AND s.user_id = b.user_id
       WHERE b.user_id = $1
       GROUP BY b.id`,
      [user_id]
    );
    const lifetimeById = {};
    lifetime.rows.forEach((row) => {
      lifetimeById[row.id] = calculateSavingsNet(row.credited, row.debited);
    });

    const bankAccounts = banks.rows.map((row) => {
      const amounts = calculateSavingsAmounts({
        amount_saved: row.amount_saved,
        amount_debited: row.amount_debited,
      });
      return {
        id: row.id,
        name: row.name,
        is_active: Boolean(row.is_active),
        amount_saved: amounts.amount_saved,
        amount_debited: amounts.amount_debited,
        saved: amounts.saved,
        debited: amounts.debited,
        net: amounts.net,
        // Bank balance for this view = month net (saved - debited), not debited-only
        total_amount: amounts.month_net,
        month_net: amounts.month_net,
        available_balance: lifetimeById[row.id] ?? 0,
      };
    });

    const overall_amount_saved = formatAmount(
      addAmounts(...bankAccounts.map((b) => b.amount_saved))
    );
    const overall_amount_debited = formatAmount(
      addAmounts(...bankAccounts.map((b) => b.amount_debited))
    );
    const overall_month_net = calculateSavingsNet(
      overall_amount_saved,
      overall_amount_debited
    );
    const overall_available = formatAmount(
      addAmounts(...bankAccounts.map((b) => b.available_balance))
    );

    return success(
      res,
      {
        month: filterMonth,
        year: filterYear,
        overall_total: overall_month_net,
        amount_saved: overall_amount_saved,
        amount_debited: overall_amount_debited,
        month_net: overall_month_net,
        available_balance: overall_available,
        bank_accounts: bankAccounts,
      },
      "Savings details fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching savings details");
  }
});

// Create credit / debit
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const amount = formatAmount(req.body.amount);
    const transaction_type = parseTransactionType(
      req.body.transaction_type ?? req.body.type
    );
    const user_id = req.body.user_id;
    const bank_account_id = req.body.bank_account_id;
    const transaction_date = parseTimestamp(req.body.date) || nowTimestamp();

    const bankCheck = await assertBankBelongsToUser(bank_account_id, user_id);
    if (bankCheck.error) {
      return badRequest(res, bankCheck.error);
    }

    if (transaction_type === "debit") {
      const debitCheck = await assertDebitAllowed(bank_account_id, amount);
      if (debitCheck.error) {
        return badRequest(res, debitCheck.error);
      }
    }

    const inserted = await db.query(
      `INSERT INTO savings_transactions
         (user_id, bank_account_id, amount, transaction_type, transaction_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user_id, bank_account_id, amount, transaction_type, transaction_date]
    );

    const result = await db.query(`${SAVING_SELECT} WHERE s.id = $1`, [
      inserted.rows[0].id,
    ]);

    return created(
      res,
      mapSaving(result.rows[0]),
      "Savings transaction created successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error creating savings transaction");
  }
});

// List transactions
// Optional: user_id, bank_account_id, transaction_type, date, month+year
router.get("/", async (req, res) => {
  try {
    const {
      user_id,
      bank_account_id,
      transaction_type,
      type,
      date,
      month,
      year,
    } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const conditions = ["s.user_id = $1"];
    const params = [user_id];

    if (bank_account_id) {
      params.push(bank_account_id);
      conditions.push(`s.bank_account_id = $${params.length}`);
    }

    const parsedType = parseTransactionType(transaction_type ?? type);
    if (transaction_type !== undefined || type !== undefined) {
      if (parsedType === null || parsedType === undefined) {
        return badRequest(res, "transaction_type must be 'credit' or 'debit'");
      }
      params.push(parsedType);
      conditions.push(`s.transaction_type = $${params.length}`);
    }

    if (date) {
      const start = dayStart(date);
      const end = dayEnd(date);
      if (!start || !end) {
        return badRequest(res, "date must be a valid date or timestamp");
      }
      params.push(start);
      conditions.push(`s.transaction_date >= $${params.length}`);
      params.push(end);
      conditions.push(`s.transaction_date <= $${params.length}`);
    } else if (month !== undefined && month !== null && month !== "") {
      const y =
        year !== undefined && year !== null && year !== ""
          ? Number(year)
          : new Date().getFullYear();
      const m = Number(month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return badRequest(res, "month must be an integer between 1 and 12");
      }
      const range = monthRangeTimestamps(y, m);
      params.push(range.start);
      conditions.push(`s.transaction_date >= $${params.length}`);
      params.push(range.end);
      conditions.push(`s.transaction_date <= $${params.length}`);
    }

    const result = await db.query(
      `${SAVING_SELECT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.transaction_date DESC, s.id DESC`,
      params
    );

    return success(
      res,
      result.rows.map(mapSaving),
      "Savings transactions fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching savings transactions");
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(`${SAVING_SELECT} WHERE s.id = $1`, [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return notFound(res, "Savings transaction not found");
    }

    return success(
      res,
      mapSaving(result.rows[0]),
      "Savings transaction fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching savings transaction");
  }
});

async function updateSaving(req, res, { partial = false } = {}) {
  try {
    const existing = await db.query(
      `SELECT * FROM savings_transactions WHERE id = $1`,
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      return notFound(res, "Savings transaction not found");
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
    const transaction_type =
      req.body.transaction_type !== undefined || req.body.type !== undefined
        ? parseTransactionType(req.body.transaction_type ?? req.body.type)
        : current.transaction_type;
    const user_id = req.body.user_id ?? current.user_id;
    const bank_account_id = req.body.bank_account_id ?? current.bank_account_id;
    const transaction_date =
      req.body.date !== undefined
        ? parseTimestamp(req.body.date) || nowTimestamp()
        : current.transaction_date;

    if (transaction_type === null) {
      return badRequest(res, "transaction_type must be 'credit' or 'debit'");
    }

    const bankCheck = await assertBankBelongsToUser(bank_account_id, user_id);
    if (bankCheck.error) {
      return badRequest(res, bankCheck.error);
    }

    if (transaction_type === "debit") {
      const debitCheck = await assertDebitAllowed(
        bank_account_id,
        amount,
        current.id
      );
      if (debitCheck.error) {
        return badRequest(res, debitCheck.error);
      }
    }

    await db.query(
      `UPDATE savings_transactions
       SET user_id = $1,
           bank_account_id = $2,
           amount = $3,
           transaction_type = $4,
           transaction_date = $5
       WHERE id = $6`,
      [
        user_id,
        bank_account_id,
        amount,
        transaction_type,
        transaction_date,
        req.params.id,
      ]
    );

    const result = await db.query(`${SAVING_SELECT} WHERE s.id = $1`, [
      req.params.id,
    ]);

    return success(
      res,
      mapSaving(result.rows[0]),
      "Savings transaction updated successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating savings transaction");
  }
}

router.put("/:id", (req, res) => updateSaving(req, res, { partial: false }));
router.patch("/:id", (req, res) => updateSaving(req, res, { partial: true }));

// Delete
router.delete("/:id", async (req, res) => {
  try {
    const existing = await db.query(`${SAVING_SELECT} WHERE s.id = $1`, [
      req.params.id,
    ]);
    if (existing.rows.length === 0) {
      return notFound(res, "Savings transaction not found");
    }

    await db.query(`DELETE FROM savings_transactions WHERE id = $1`, [
      req.params.id,
    ]);

    return success(
      res,
      mapSaving(existing.rows[0]),
      "Savings transaction deleted successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error deleting savings transaction");
  }
});

module.exports = router;
