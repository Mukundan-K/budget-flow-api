const db = require("../../db");
const { monthRangeTimestamps } = require("../../utils/datetime");
const { calculateDebtSummary } = require("./debt.service");

/**
 * Month debt activity (dashboard / remaining balance):
 * given_net     = given this month − returns on given this month
 * received_net  = received this month − repayments this month
 * debt_net      = given_net − received_net
 *
 * Received repayments this month (I paid back):
 * received_returned            = all repayments this month
 * received_repaid_this_month   = repayments this month on received debts from this month
 * received_repaid_past_months  = repayments this month on received debts from any past month
 */
async function getDebtMonthNetForMonth(userId, year, month, client = db) {
  const { start, end } = monthRangeTimestamps(year, month);

  const originated = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN debt_type = 'given' THEN amount ELSE 0 END), 0) AS given_total,
       COALESCE(SUM(CASE WHEN debt_type = 'received' THEN amount ELSE 0 END), 0) AS received_total
     FROM debts
     WHERE user_id = $1
       AND debt_date >= $2
       AND debt_date <= $3`,
    [userId, start, end]
  );

  const returns = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN d.debt_type = 'given' AND r.return_date >= $2 AND r.return_date <= $3 THEN r.amount ELSE 0 END), 0) AS given_returned,
       COALESCE(SUM(CASE WHEN d.debt_type = 'received' AND r.return_date >= $2 AND r.return_date <= $3 THEN r.amount ELSE 0 END), 0) AS received_returned,
       COALESCE(SUM(CASE WHEN d.debt_type = 'received' AND r.return_date >= $2 AND r.return_date <= $3 AND d.debt_date >= $2 AND d.debt_date <= $3 THEN r.amount ELSE 0 END), 0) AS received_repaid_this_month,
       COALESCE(SUM(CASE WHEN d.debt_type = 'received' AND r.return_date >= $2 AND r.return_date <= $3 AND d.debt_date < $2 THEN r.amount ELSE 0 END), 0) AS received_repaid_past_months
     FROM debt_returns r
     JOIN debts d ON d.id = r.debt_id
     WHERE r.user_id = $1`,
    [userId, start, end]
  );

  const originatedRow = originated.rows[0];
  const returnsRow = returns.rows[0];
  const summary = calculateDebtSummary({
    given_total: originatedRow.given_total,
    given_returned: returnsRow.given_returned,
    received_total: originatedRow.received_total,
    received_returned: returnsRow.received_returned,
    received_repaid_this_month: returnsRow.received_repaid_this_month,
    received_repaid_past_months: returnsRow.received_repaid_past_months,
  });

  return {
    given_total: summary.given_total,
    given_returned: summary.given_returned,
    given_net: summary.given_net,
    received_total: summary.received_total,
    received_returned: summary.received_returned,
    received_net: summary.received_net,
    received_repaid_this_month: summary.received_repaid_this_month,
    received_repaid_past_months: summary.received_repaid_past_months,
    // Positive = money out of pocket from debt activity this month
    debt: summary.debt,
    debt_net: summary.debt_net,
  };
}

function toDebtOverview(summary) {
  return {
    given_total: summary.given_total,
    given_returned: summary.given_returned,
    given_net: summary.given_net,
    received_total: summary.received_total,
    received_returned: summary.received_returned,
    received_net: summary.received_net,
    debt_net: summary.debt_net,
    received_repaid_this_month: summary.received_repaid_this_month || 0,
    received_repaid_past_months: summary.received_repaid_past_months || 0,
  };
}

module.exports = {
  getDebtMonthNetForMonth,
  toDebtOverview,
};
