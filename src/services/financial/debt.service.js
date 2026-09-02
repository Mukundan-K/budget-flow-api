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
 * (or given_net − received_net for month activity)
 */
function calculateDebtNet(givenOutstanding = 0, receivedOutstanding = 0) {
  return roundMoney(toAmount(givenOutstanding) - toAmount(receivedOutstanding));
}

function calculateDebtSummary({
  given_total = 0,
  given_returned = 0,
  received_total = 0,
  received_returned = 0,
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

  return {
    given_total: toAmount(given_total),
    given_returned: toAmount(given_returned),
    given_outstanding,
    given_net: given_outstanding,
    received_total: toAmount(received_total),
    received_returned: toAmount(received_returned),
    received_outstanding,
    received_net: received_outstanding,
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
};
