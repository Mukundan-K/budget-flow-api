const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  badRequest,
  serverError,
} = require("../utils/response");
const { parseAmount, formatAmount, addAmounts } = require("../utils/money");
const {
  formatTimestamp,
  monthRangeTimestamps,
} = require("../utils/datetime");

function toAmount(value) {
  const amount = parseAmount(value);
  return amount === null ? 0 : amount;
}

function roundMoney(value) {
  // Keep full decimal precision for money totals
  return formatAmount(value);
}

function monthRange(year, month) {
  return monthRangeTimestamps(year, month);
}

function nextMonth(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function compareYearMonth(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

function parseMonthYear(month, year) {
  const now = new Date();
  const selectedYear = year !== undefined && year !== null && year !== ""
    ? Number(year)
    : now.getFullYear();
  const selectedMonth = month !== undefined && month !== null && month !== ""
    ? Number(month)
    : now.getMonth() + 1;

  if (
    !Number.isInteger(selectedMonth) ||
    selectedMonth < 1 ||
    selectedMonth > 12
  ) {
    return { error: "month must be an integer between 1 and 12" };
  }

  if (!Number.isInteger(selectedYear) || selectedYear < 2000) {
    return { error: "year must be a valid year" };
  }

  return { month: selectedMonth, year: selectedYear };
}

async function getIncomeTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.is_income = TRUE
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
}

async function getOutgoingPaymentsTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.is_income = FALSE
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
}

async function getExpenseTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(e.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM expenses e
     LEFT JOIN (
       SELECT expense_id, SUM(amount) AS returned_amount
       FROM expense_returns
       GROUP BY expense_id
     ) ret ON ret.expense_id = e.id
     WHERE e.user_id = $1
       AND e.expense_date >= $2
       AND e.expense_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
}

/** Savings month net (credited − debited) — applied as from_savings in balance. */
async function getSavingsMonthNetForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) AS credited,
       COALESCE(SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END), 0) AS debited
     FROM savings_transactions
     WHERE user_id = $1
       AND transaction_date >= $2
       AND transaction_date <= $3`,
    [userId, start, end]
  );
  const credited = toAmount(result.rows[0].credited);
  const debited = toAmount(result.rows[0].debited);
  return {
    credited,
    debited,
    month_net: roundMoney(credited - debited),
  };
}

/** Debt month net for balance:
 * given_net − received_net
 * given_net     = given this month − returns on given this month
 * received_net  = received this month − repayments this month
 */
async function getDebtMonthNetForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);

  const given = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM debts
     WHERE user_id = $1
       AND debt_type = 'given'
       AND debt_date >= $2
       AND debt_date <= $3`,
    [userId, start, end]
  );

  const givenReturns = await db.query(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
     FROM debt_returns r
     JOIN debts d ON d.id = r.debt_id
     WHERE r.user_id = $1
       AND d.debt_type = 'given'
       AND r.return_date >= $2
       AND r.return_date <= $3`,
    [userId, start, end]
  );

  const received = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM debts
     WHERE user_id = $1
       AND debt_type = 'received'
       AND debt_date >= $2
       AND debt_date <= $3`,
    [userId, start, end]
  );

  const receivedReturns = await db.query(
    `SELECT COALESCE(SUM(r.amount), 0) AS total
     FROM debt_returns r
     JOIN debts d ON d.id = r.debt_id
     WHERE r.user_id = $1
       AND d.debt_type = 'received'
       AND r.return_date >= $2
       AND r.return_date <= $3`,
    [userId, start, end]
  );

  const given_total = toAmount(given.rows[0].total);
  const given_returned = toAmount(givenReturns.rows[0].total);
  const received_total = toAmount(received.rows[0].total);
  const received_returned = toAmount(receivedReturns.rows[0].total);
  const given_net = roundMoney(given_total - given_returned);
  const received_net = roundMoney(received_total - received_returned);

  return {
    given_total,
    given_returned,
    given_net,
    received_total,
    received_returned,
    received_net,
    // Positive = money out of pocket from debt activity this month
    debt: roundMoney(given_net - received_net),
  };
}

async function getLatestSalaryPayment(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT p.id, p.amount, p.payment_date
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     WHERE p.user_id = $1
       AND LOWER(pt.name) = 'salary'
       AND p.payment_date >= $2
       AND p.payment_date <= $3
     ORDER BY p.payment_date DESC, p.id DESC
     LIMIT 1`,
    [userId, start, end]
  );
  return result.rows[0] || null;
}

async function getStoredPreviousBalance(userId, year, month) {
  const result = await db.query(
    `SELECT previous_month_balance
     FROM monthly_balances
     WHERE user_id = $1 AND year = $2 AND month = $3`,
    [userId, year, month]
  );

  if (result.rows.length === 0) return null;
  return toAmount(result.rows[0].previous_month_balance);
}

async function findEarliestYearMonth(userId) {
  const result = await db.query(
    `
    SELECT MIN(d) AS earliest FROM (
      SELECT MIN(payment_date) AS d FROM payments WHERE user_id = $1
      UNION ALL
      SELECT MIN(expense_date) AS d FROM expenses WHERE user_id = $1
      UNION ALL
      SELECT MIN(transaction_date) AS d FROM savings_transactions WHERE user_id = $1
      UNION ALL
      SELECT MIN(debt_date) AS d FROM debts WHERE user_id = $1
      UNION ALL
      SELECT MAKE_DATE(year, month, 1) AS d FROM monthly_balances WHERE user_id = $1
    ) t
    `,
    [userId]
  );

  const earliest = result.rows[0]?.earliest;
  if (!earliest) return null;

  const date = new Date(earliest);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

async function buildMonthOverview(userId, year, month) {
  const target = { year: Number(year), month: Number(month) };
  const earliest = await findEarliestYearMonth(userId);

  let previousMonthBalance = 0;
  let cursor = earliest || target;

  if (earliest && compareYearMonth(target, earliest) < 0) {
    cursor = target;
  }

  while (compareYearMonth(cursor, target) <= 0) {
    const storedPrevious = await getStoredPreviousBalance(
      userId,
      cursor.year,
      cursor.month
    );
    if (storedPrevious !== null) {
      previousMonthBalance = storedPrevious;
    }

    const salary = await getIncomeTotalForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const outgoingPayments = await getOutgoingPaymentsTotalForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const expenseTotal = await getExpenseTotalForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    // From savings = month net (credited − debited)
    const savings = await getSavingsMonthNetForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const fromSavings = savings.month_net;
    const debtInfo = await getDebtMonthNetForMonth(
      userId,
      cursor.year,
      cursor.month
    );
    const debt = debtInfo.debt;
    // Balance = (Income + Prev.) − (from_savings + expenses + debt + outgoing)
    const totalAmountToSpend = roundMoney(salary + previousMonthBalance);
    const totalDeductions = roundMoney(
      fromSavings + expenseTotal + debt + outgoingPayments
    );
    const currentBalance = roundMoney(totalAmountToSpend - totalDeductions);

    if (cursor.year === target.year && cursor.month === target.month) {
      const latestSalary = await getLatestSalaryPayment(
        userId,
        cursor.year,
        cursor.month
      );

      return {
        user_id: Number(userId),
        month: cursor.month,
        year: cursor.year,
        date: latestSalary
          ? formatTimestamp(latestSalary.payment_date)
          : null,
        salary,
        previous_month_balance: previousMonthBalance,
        previous_month_balance_manual: storedPrevious !== null,
        from_savings: fromSavings,
        savings_credited: fromSavings,
        savings_month_net: fromSavings,
        savings_amount_saved: savings.credited,
        savings_amount_debited: savings.debited,
        debt,
        debt_given_net: debtInfo.given_net,
        debt_received_net: debtInfo.received_net,
        debt_given_total: debtInfo.given_total,
        debt_given_returned: debtInfo.given_returned,
        debt_received_total: debtInfo.received_total,
        debt_received_returned: debtInfo.received_returned,
        total_amount_to_spend: totalAmountToSpend,
        total_deductions: totalDeductions,
        total_expenses: roundMoney(expenseTotal + outgoingPayments),
        expense_total: expenseTotal,
        outgoing_payments_total: outgoingPayments,
        current_balance: currentBalance,
      };
    }

    previousMonthBalance = currentBalance;
    cursor = nextMonth(cursor.year, cursor.month);
  }

  return null;
}

// Monthly overview
// GET /api/overview?user_id=1
// GET /api/overview?user_id=1&month=8&year=2026
router.get("/", async (req, res) => {
  try {
    const { user_id, month, year } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const parsed = parseMonthYear(month, year);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const overview = await buildMonthOverview(
      user_id,
      parsed.year,
      parsed.month
    );

    return success(res, overview, "Monthly overview fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching monthly overview");
  }
});

// Update previous month balance for a given month
// PUT|PATCH /api/overview/previous-balance
async function updatePreviousBalance(req, res) {
  try {
    const { user_id, month, year, previous_month_balance } = req.body;

    if (user_id === undefined || user_id === null || user_id === "") {
      return badRequest(res, "user_id is required");
    }

    if (
      previous_month_balance === undefined ||
      previous_month_balance === null ||
      previous_month_balance === ""
    ) {
      return badRequest(res, "previous_month_balance is required");
    }

    const balance = Number(previous_month_balance);
    if (Number.isNaN(balance)) {
      return badRequest(res, "previous_month_balance must be a number");
    }

    const parsed = parseMonthYear(month, year);
    if (parsed.error) {
      return badRequest(res, parsed.error);
    }

    const result = await db.query(
      `INSERT INTO monthly_balances (user_id, month, year, previous_month_balance, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, month, year)
       DO UPDATE SET
         previous_month_balance = EXCLUDED.previous_month_balance,
         updated_at = NOW()
       RETURNING id, user_id, month, year, previous_month_balance, updated_at`,
      [user_id, parsed.month, parsed.year, roundMoney(balance)]
    );

    const overview = await buildMonthOverview(
      user_id,
      parsed.year,
      parsed.month
    );

    return success(
      res,
      {
        previous_balance: {
          id: result.rows[0].id,
          user_id: result.rows[0].user_id,
          month: result.rows[0].month,
          year: result.rows[0].year,
          previous_month_balance: toAmount(
            result.rows[0].previous_month_balance
          ),
          updated_at: result.rows[0].updated_at,
        },
        overview,
      },
      "Previous month balance updated successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error updating previous month balance");
  }
}

router.put("/previous-balance", updatePreviousBalance);
router.patch("/previous-balance", updatePreviousBalance);

module.exports = router;
