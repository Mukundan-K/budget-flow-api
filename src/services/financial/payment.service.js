const { roundMoney, toAmount } = require("./_helpers");

/**
 * Canonical payment amounts.
 * net_amount = amount − returned_amount
 */
function calculatePaymentNet(amount, returnedAmount = 0) {
  const a = toAmount(amount);
  const r = toAmount(returnedAmount);
  return roundMoney(a - r);
}

function calculatePaymentAmounts({ amount, returned_amount = 0 } = {}) {
  const amt = toAmount(amount);
  const returned = toAmount(returned_amount);
  const net_amount = calculatePaymentNet(amt, returned);
  return {
    amount: amt,
    returned_amount: returned,
    net_amount,
    // Existing convention: payment contribution equals net
    my_contribution: net_amount,
  };
}

/**
 * Incoming split by is_income (earned vs not earned) — independent of flow.
 *
 *   incoming            = earned + not_earned  (all flow=incoming)
 *   earned              = incoming ∧ is_income
 *   not_earned          = incoming ∧ !is_income
 *
 * User-facing Available is computed separately:
 *   available           = earned + previous_month_balance
 */
function splitAvailableFromIncoming({ earned = 0, not_earned = 0 } = {}) {
  const earnedAmt = toAmount(earned);
  const notEarnedAmt = toAmount(not_earned);
  const total = roundMoney(earnedAmt + notEarnedAmt);
  return {
    total,
    earned: earnedAmt,
    not_earned: notEarnedAmt,
    available: total,
    available_earned: earnedAmt,
    available_not_earned: notEarnedAmt,
    incoming: total,
  };
}

/**
 * Available total = earned income + previous month balance.
 * not_earned incoming is reported but not included in available.total.
 */
function splitAvailableFromEarnedAndPrevious({
  earned = 0,
  not_earned = 0,
  previous = 0,
} = {}) {
  const earnedAmt = toAmount(earned);
  const notEarnedAmt = toAmount(not_earned);
  const previousAmt = toAmount(previous);
  const total = roundMoney(earnedAmt + previousAmt);
  return {
    total,
    earned: earnedAmt,
    not_earned: notEarnedAmt,
    previous: previousAmt,
    available: total,
  };
}

/**
 * Classify a payment type: flow = direction, is_income = earned flag.
 */
function classifyPaymentTypeFlow({ flow, is_income } = {}) {
  const normalizedFlow =
    flow === "incoming" || flow === "outgoing"
      ? flow
      : Boolean(is_income)
        ? "incoming"
        : "outgoing";
  const earned = Boolean(is_income);

  return {
    flow: normalizedFlow,
    is_income: earned,
    is_incoming: normalizedFlow === "incoming",
    is_outgoing: normalizedFlow === "outgoing",
    is_earned: normalizedFlow === "incoming" && earned,
    is_not_earned: normalizedFlow === "incoming" && !earned,
  };
}

module.exports = {
  calculatePaymentNet,
  calculatePaymentAmounts,
  splitAvailableFromIncoming,
  splitAvailableFromEarnedAndPrevious,
  classifyPaymentTypeFlow,
};
