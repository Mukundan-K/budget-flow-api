const db = require("../../db");
const { monthRangeTimestamps } = require("../../utils/datetime");
const {
  calculateDebtSummary,
} = require("./debt.service");

async function getDebtActivityForRange(userId, start, end, client = db) {
  const originated = await client.query(
    `SELECT
       COALESCE(SUM(CASE WHEN debt_type = 'given' THEN amount ELSE 0 END), 0) AS given_total,
       COALESCE(SUM(CASE WHEN debt_type = 'received' THEN amount ELSE 0 END), 0) AS received_total,
       COALESCE(SUM(CASE WHEN debt_type = 'returned_to_me' THEN amount ELSE 0 END), 0) AS given_returned,
       COALESCE(SUM(CASE WHEN debt_type = 'returned_by_me' THEN amount ELSE 0 END), 0) AS received_returned
     FROM debts
     WHERE user_id = $1
       AND debt_date >= $2
       AND debt_date <= $3`,
    [userId, start, end]
  );

  const originatedRow = originated.rows[0];
  const summary = calculateDebtSummary({
    given_total: originatedRow.given_total,
    given_returned: originatedRow.given_returned,
    received_total: originatedRow.received_total,
    received_returned: originatedRow.received_returned,
    received_repaid_this_month: originatedRow.received_returned,
    received_repaid_past_months: 0,
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
    debt: summary.debt,
    debt_net: summary.debt_net,
  };
}

/**
 * Month debt activity (dashboard / remaining balance):
 * given_net     = given this month − returned_to_me this month
 * received_net  = received this month − returned_by_me this month
 * debt_net      = given_net − received_net
 *
 * Dates always come from debts.debt_date for all four types.
 */
async function getDebtMonthNetForMonth(userId, year, month, client = db) {
  const { start, end } = monthRangeTimestamps(year, month);
  return getDebtActivityForRange(userId, start, end, client);
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
  getDebtActivityForRange,
  getDebtMonthNetForMonth,
  toDebtOverview,
};
