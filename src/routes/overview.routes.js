const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  badRequest,
  serverError,
} = require("../utils/response");

function toAmount(value) {
  const amount = Number(value);
  if (Number.isNaN(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthRange(year, month) {
  const start = `${year}-${pad2(month)}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

function nextMonth(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function compareYearMonth(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

async function getIncomeTotalForMonth(userId, year, month) {
  const { start, end } = monthRange(year, month);
  const result = await db.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
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
    `SELECT COALESCE(SUM(p.amount), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
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
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM expenses
     WHERE user_id = $1
       AND expense_date >= $2
       AND expense_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
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

async function findEarliestYearMonth(userId) {
  const result = await db.query(
    `
    SELECT MIN(d) AS earliest FROM (
      SELECT MIN(payment_date) AS d FROM payments WHERE user_id = $1
      UNION ALL
      SELECT MIN(expense_date) AS d FROM expenses WHERE user_id = $1
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
    const totalExpenses = roundMoney(expenseTotal + outgoingPayments);
    const totalAmountToSpend = roundMoney(salary + previousMonthBalance);
    const currentBalance = roundMoney(totalAmountToSpend - totalExpenses);

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
          ? new Date(latestSalary.payment_date).toISOString().slice(0, 10)
          : null,
        salary,
        previous_month_balance: previousMonthBalance,
        total_amount_to_spend: totalAmountToSpend,
        total_expenses: totalExpenses,
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

    const now = new Date();
    const selectedYear = year ? Number(year) : now.getFullYear();
    const selectedMonth = month ? Number(month) : now.getMonth() + 1;

    if (
      !Number.isInteger(selectedMonth) ||
      selectedMonth < 1 ||
      selectedMonth > 12
    ) {
      return badRequest(res, "month must be an integer between 1 and 12");
    }

    if (!Number.isInteger(selectedYear) || selectedYear < 2000) {
      return badRequest(res, "year must be a valid year");
    }

    const overview = await buildMonthOverview(
      user_id,
      selectedYear,
      selectedMonth
    );

    return success(res, overview, "Monthly overview fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching monthly overview");
  }
});

module.exports = router;
