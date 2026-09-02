const { roundMoney, toAmount } = require("./_helpers");
const { splitAvailableFromIncoming } = require("./payment.service");

/**
 * Effective previous balance:
 *   manual value when provided (including 0)
 *   otherwise calculated from previous month Remaining
 */
function calculatePreviousBalance({
  manual = null,
  calculated = 0,
} = {}) {
  const calculatedValue = toAmount(calculated);
  const hasManual = manual !== null && manual !== undefined && manual !== "";
  const previous_balance = hasManual ? toAmount(manual) : calculatedValue;

  return {
    previous_balance,
    previous_balance_calculated: calculatedValue,
    previous_balance_manual: hasManual,
    previous_month_balance: previous_balance,
    previous_month_balance_calculated: calculatedValue,
    previous_month_balance_manual: hasManual,
  };
}

/**
 * Primary monthly Remaining formula:
 *   Remaining = Incoming + Previous − Spent − Savings − Debt
 *
 * Incoming = all payments with flow = incoming (= earned + not_earned)
 * Available (user-facing) = Incoming, split into earned / not_earned
 * Spendable (total_amount_to_spend) = Incoming + Previous
 *
 * Spent = expense nets + outgoing payment nets (flow = outgoing)
 */
function calculateMonthlyBalance({
  incoming = 0,
  earned,
  not_earned,
  previous = 0,
  spent = 0,
  savings = 0,
  debt = 0,
  expense_total,
  outgoing_payments_total,
} = {}) {
  const prev = toAmount(previous);
  const savingsNet = toAmount(savings);
  const debtNet = toAmount(debt);

  let earnedAmt;
  let notEarnedAmt;
  let income;

  if (earned !== undefined || not_earned !== undefined) {
    const split = splitAvailableFromIncoming({
      earned: earned || 0,
      not_earned: not_earned || 0,
    });
    earnedAmt = split.earned;
    notEarnedAmt = split.not_earned;
    income = split.total;
  } else {
    income = toAmount(incoming);
    earnedAmt = income;
    notEarnedAmt = 0;
  }

  let expenseTotal = 0;
  let outgoing = 0;
  let spentValue;

  if (expense_total !== undefined || outgoing_payments_total !== undefined) {
    expenseTotal = toAmount(expense_total || 0);
    outgoing = toAmount(outgoing_payments_total || 0);
    spentValue = roundMoney(expenseTotal + outgoing);
  } else {
    spentValue = toAmount(spent);
  }

  const available_split = {
    total: income,
    earned: earnedAmt,
    not_earned: notEarnedAmt,
  };
  const available = income;

  const total_amount_to_spend = roundMoney(income + prev);
  const total_deductions = roundMoney(spentValue + savingsNet + debtNet);
  const remaining = roundMoney(total_amount_to_spend - total_deductions);

  return {
    incoming: income,
    earned: earnedAmt,
    not_earned: notEarnedAmt,
    available,
    available_split,
    previous_balance: prev,
    total_amount_to_spend,
    spent: spentValue,
    total_spent: spentValue,
    expense_total: expenseTotal,
    outgoing_payments_total: outgoing,
    savings: savingsNet,
    from_savings: savingsNet,
    debt: debtNet,
    total_deductions,
    remaining,
    current_balance: remaining,
    balance: remaining,
  };
}

/**
 * Canonical monthly financial summary object.
 */
function calculateFinancialSummary({
  incoming = 0,
  earned,
  not_earned,
  previous_balance = 0,
  previous_balance_calculated = null,
  previous_balance_manual = false,
  spent = 0,
  savings = 0,
  debt = 0,
  expense_total,
  outgoing_payments_total,
} = {}) {
  const monthly = calculateMonthlyBalance({
    incoming,
    earned,
    not_earned,
    previous: previous_balance,
    spent,
    savings,
    debt,
    expense_total,
    outgoing_payments_total,
  });

  const calculated =
    previous_balance_calculated === null ||
    previous_balance_calculated === undefined
      ? monthly.previous_balance
      : toAmount(previous_balance_calculated);

  return {
    previous_balance: monthly.previous_balance,
    previous_balance_calculated: calculated,
    previous_balance_manual: Boolean(previous_balance_manual),
    incoming: monthly.incoming,
    earned: monthly.earned,
    not_earned: monthly.not_earned,
    available: monthly.available,
    available_split: monthly.available_split,
    spent: monthly.spent,
    savings: monthly.savings,
    debt: monthly.debt,
    remaining: monthly.remaining,
    from_savings: monthly.from_savings,
    current_balance: monthly.remaining,
    balance: monthly.remaining,
    total_amount_to_spend: monthly.total_amount_to_spend,
    total_spent: monthly.spent,
    total_deductions: monthly.total_deductions,
    expense_total: monthly.expense_total,
    outgoing_payments_total: monthly.outgoing_payments_total,
  };
}

/**
 * Map overview row → canonical summary (same Remaining everywhere).
 */
function toCanonicalMonthlySummary(overview) {
  if (!overview) return null;

  return calculateFinancialSummary({
    incoming: overview.salary ?? overview.incoming ?? 0,
    earned: overview.earned,
    not_earned: overview.not_earned,
    previous_balance:
      overview.previous_month_balance ?? overview.previous_balance ?? 0,
    previous_balance_calculated:
      overview.previous_month_balance_calculated ??
      overview.previous_balance_calculated ??
      null,
    previous_balance_manual:
      overview.previous_month_balance_manual ??
      overview.previous_balance_manual ??
      false,
    expense_total: overview.expense_total,
    outgoing_payments_total: overview.outgoing_payments_total,
    savings: overview.from_savings ?? overview.savings ?? 0,
    debt: overview.debt ?? overview.debt_net ?? 0,
  });
}

module.exports = {
  calculatePreviousBalance,
  calculateMonthlyBalance,
  calculateFinancialSummary,
  toCanonicalMonthlySummary,
};
