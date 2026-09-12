const { roundMoney, toAmount } = require("./_helpers");

/**
 * outstanding / net = amount − returned_amount
 */
function calculateDebtOutstanding(amount, returnedAmount = 0) {
  return roundMoney(toAmount(amount) - toAmount(returnedAmount));
}

function calculateDebtAmounts({ amount, returned_amount = 0 } = {}) {
  const amt = toAmount(amount);
  const returned = toAmount(returned_amount);
  const outstanding = calculateDebtOutstanding(amt, returned);
  const is_pending_zero = outstanding <= 0;
  return {
    amount: amt,
    total: amt,
    returned_amount: returned,
    returned,
    net_amount: outstanding,
    outstanding,
    // true when nothing left to repay — UI can skip repay modal
    is_pending_zero,
    has_pending: !is_pending_zero,
  };
}

/**
 * debt_net = given_outstanding − received_outstanding
 * (or given_net − received_net for month activity / remaining-balance cash flow)
 */
function calculateDebtNet(givenOutstanding = 0, receivedOutstanding = 0) {
  return roundMoney(toAmount(givenOutstanding) - toAmount(receivedOutstanding));
}

/**
 * Current outstanding balances (all history, never month-filtered).
 *
 * I Owe Them  = Received − Returned by me
 * They Owe Me = Given − Returned to me
 * Net Amount  = I Owe Them − They Owe Me
 *   positive → I owe overall; negative → they owe me; zero → settled
 */
function calculatePersonBalances({
  received_total = 0,
  returned_by_me = 0,
  given_total = 0,
  returned_to_me = 0,
} = {}) {
  const received = toAmount(received_total);
  const given = toAmount(given_total);
  const returnedByMe = toAmount(returned_by_me);
  const returnedToMe = toAmount(returned_to_me);
  const i_owe_them = roundMoney(received - returnedByMe);
  const they_owe_me = roundMoney(given - returnedToMe);
  const net_amount = roundMoney(i_owe_them - they_owe_me);
  return {
    received_total: received,
    given_total: given,
    returned_by_me: returnedByMe,
    returned_to_me: returnedToMe,
    i_owe_them,
    they_owe_me,
    net_amount,
  };
}

function formatDebtYearMonth(year, month) {
  return `${Number(year)}-${String(Number(month)).padStart(2, "0")}`;
}

/**
 * Month-end outstanding using the same rules as Debt Overview:
 * I Owe Them / They Owe Me / Net Debt. Negatives are preserved.
 */
function monthlyDebtTrendPoint(year, month, totals = {}) {
  const balances = calculatePersonBalances(totals);
  return {
    month: formatDebtYearMonth(year, month),
    year: Number(year),
    month_number: Number(month),
    i_owe_them: balances.i_owe_them,
    they_owe_me: balances.they_owe_me,
    net_debt: balances.net_amount,
    iOweThem: balances.i_owe_them,
    theyOweMe: balances.they_owe_me,
    netDebt: balances.net_amount,
  };
}

function emptyDebtTotals() {
  return {
    received_total: 0,
    returned_by_me: 0,
    given_total: 0,
    returned_to_me: 0,
  };
}

function addDebtTotals(base = {}, extra = {}) {
  return {
    received_total: roundMoney(
      toAmount(base.received_total) + toAmount(extra.received_total)
    ),
    returned_by_me: roundMoney(
      toAmount(base.returned_by_me) + toAmount(extra.returned_by_me)
    ),
    given_total: roundMoney(
      toAmount(base.given_total) + toAmount(extra.given_total)
    ),
    returned_to_me: roundMoney(
      toAmount(base.returned_to_me) + toAmount(extra.returned_to_me)
    ),
  };
}

/**
 * 12 month-end balances for a year. Each month carries forward prior
 * outstanding, matching Debt Overview at year-end when all history is included.
 */
function fillMonthlyDebtTrendYear(year, byMonth = new Map(), opening = {}) {
  let running = addDebtTotals(emptyDebtTotals(), opening);
  const points = [];
  for (let month = 1; month <= 12; month++) {
    running = addDebtTotals(running, byMonth.get(month) || emptyDebtTotals());
    points.push(monthlyDebtTrendPoint(year, month, running));
  }
  return points;
}

function calculateDebtSummary({
  given_total = 0,
  given_returned = 0,
  received_total = 0,
  received_returned = 0,
  received_repaid_this_month = 0,
  received_repaid_past_months = 0,
} = {}) {
  const given_outstanding = calculateDebtOutstanding(given_total, given_returned);
  const received_outstanding = calculateDebtOutstanding(
    received_total,
    received_returned
  );
  const debt_net = calculateDebtNet(given_outstanding, received_outstanding);
  const total = roundMoney(toAmount(given_total) + toAmount(received_total));
  const returned = roundMoney(
    toAmount(given_returned) + toAmount(received_returned)
  );
  const outstanding = roundMoney(given_outstanding + received_outstanding);
  const repaid_this_month = toAmount(received_repaid_this_month);
  const repaid_past_months = toAmount(received_repaid_past_months);

  return {
    given_total: toAmount(given_total),
    given_returned: toAmount(given_returned),
    given_outstanding,
    given_net: given_outstanding,
    received_total: toAmount(received_total),
    received_returned: toAmount(received_returned),
    received_outstanding,
    received_net: received_outstanding,
    received_repaid_this_month: repaid_this_month,
    received_repaid_past_months: repaid_past_months,
    total,
    returned,
    outstanding,
    debt_net,
    debt: debt_net,
  };
}

module.exports = {
  calculateDebtOutstanding,
  calculateDebtAmounts,
  calculateDebtNet,
  calculateDebtSummary,
  calculatePersonBalances,
  monthlyDebtTrendPoint,
  fillMonthlyDebtTrendYear,
};
