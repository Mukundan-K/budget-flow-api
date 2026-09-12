/**
 * Source-table month aggregations used by Remaining (overview) and
 * monthly_financial_summary rebuild. SQL must stay identical to the
 * historical Remaining engine. Optional `client` supports transactions.
 */
const db = require("../../db");
const {
  monthRangeTimestamps,
  getZonedCalendarParts,
} = require("../../utils/datetime");
const { roundMoney, toAmount } = require("./_helpers");

function monthRange(year, month) {
  return monthRangeTimestamps(year, month);
}

function timestampToYearMonth(value) {
  if (value === undefined || value === null || value === "") return null;
  const parts = getZonedCalendarParts(new Date(value));
  if (!parts.year || !parts.month) return null;
  return { year: parts.year, month: parts.month };
}

async function getIncomingBreakdownForMonth(userId, year, month, client = db) {
  const { start, end } = monthRange(year, month);
  const result = await client.query(
    `SELECT
       COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total,
       COALESCE(SUM(
         CASE WHEN pt.is_income = TRUE
           THEN p.amount - COALESCE(ret.returned_amount, 0)
           ELSE 0
         END
       ), 0) AS earned,
       COALESCE(SUM(
         CASE WHEN pt.is_income = FALSE
           THEN p.amount - COALESCE(ret.returned_amount, 0)
           ELSE 0
         END
       ), 0) AS not_earned
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.flow = 'incoming'
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  const row = result.rows[0];
  return {
    total: toAmount(row.total),
    earned: toAmount(row.earned),
    not_earned: toAmount(row.not_earned),
  };
}

async function getOutgoingPaymentsTotalForMonth(
  userId,
  year,
  month,
  client = db
) {
  const { start, end } = monthRange(year, month);
  const result = await client.query(
    `SELECT COALESCE(SUM(p.amount - COALESCE(ret.returned_amount, 0)), 0) AS total
     FROM payments p
     JOIN payment_types pt ON pt.id = p.payment_type_id
     LEFT JOIN (
       SELECT payment_id, SUM(amount) AS returned_amount
       FROM payment_returns
       GROUP BY payment_id
     ) ret ON ret.payment_id = p.id
     WHERE p.user_id = $1
       AND pt.flow = 'outgoing'
       AND p.payment_date >= $2
       AND p.payment_date <= $3`,
    [userId, start, end]
  );
  return toAmount(result.rows[0].total);
}

async function getExpenseTotalForMonth(userId, year, month, client = db) {
  const { start, end } = monthRange(year, month);
  const result = await client.query(
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

async function getSavingsMonthNetForMonth(userId, year, month, client = db) {
  const { start, end } = monthRange(year, month);
  const result = await client.query(
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

async function findEarliestYearMonth(userId, client = db) {
  const result = await client.query(
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

  return timestampToYearMonth(earliest);
}

async function findLatestYearMonth(userId, client = db) {
  const result = await client.query(
    `
    SELECT MAX(d) AS latest FROM (
      SELECT MAX(payment_date) AS d FROM payments WHERE user_id = $1
      UNION ALL
      SELECT MAX(expense_date) AS d FROM expenses WHERE user_id = $1
      UNION ALL
      SELECT MAX(transaction_date) AS d FROM savings_transactions WHERE user_id = $1
      UNION ALL
      SELECT MAX(debt_date) AS d FROM debts WHERE user_id = $1
      UNION ALL
      SELECT MAKE_DATE(year, month, 1) AS d FROM monthly_balances WHERE user_id = $1
    ) t
    `,
    [userId]
  );

  const latest = result.rows[0]?.latest;
  if (!latest) return null;

  return timestampToYearMonth(latest);
}

module.exports = {
  getIncomingBreakdownForMonth,
  getOutgoingPaymentsTotalForMonth,
  getExpenseTotalForMonth,
  getSavingsMonthNetForMonth,
  findEarliestYearMonth,
  findLatestYearMonth,
};
