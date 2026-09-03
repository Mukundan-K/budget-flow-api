/**
 * Financial summary shaping for dashboard / overview / activities.
 * Pure transforms over already-fetched overview numbers.
 */
const {
  calculateFinancialSummary,
  toCanonicalMonthlySummary,
} = require("./balance.service");
const { calculateDashboardPercentages } = require("./percentages.service");
const { calculateSavingsAmounts } = require("./savings.service");
const { calculateDebtSummary } = require("./debt.service");
const { calculateEmiProgress } = require("./emi.service");
const { splitAvailableFromEarnedAndPrevious } = require("./payment.service");
const { roundMoney, toAmount } = require("./_helpers");

/**
 * Build dashboard-oriented balance + percentages from a month overview
 * and optional expense type / savings breakdown.
 */
function buildDashboardFinancialBlock(overview, extras = {}) {
  const summary = toCanonicalMonthlySummary(overview);
  if (!summary) return null;

  const necessary = toAmount(extras.necessary);
  const unnecessary = toAmount(extras.unnecessary);
  const saved = toAmount(
    extras.saved ?? overview.savings_amount_saved ?? 0
  );
  const debited = toAmount(
    extras.debited ?? overview.savings_amount_debited ?? 0
  );

  const percentages = calculateDashboardPercentages({
    total_deductions: summary.total_deductions,
    available: summary.available,
    necessary,
    unnecessary,
    saved,
    debited,
  });

  const savings = calculateSavingsAmounts({
    amount_saved: saved,
    amount_debited: debited,
  });

  const debts = calculateDebtSummary({
    given_total: overview.debt_given_total,
    given_returned: overview.debt_given_returned,
    received_total: overview.debt_received_total,
    received_returned: overview.debt_received_returned,
  });

  return {
    // Canonical nested balance (additive — does not remove legacy root fields)
    balance: {
      previous: summary.previous_balance,
      previous_balance_manual: summary.previous_balance_manual
        ? summary.previous_balance
        : null,
      previous_balance_calculated: summary.previous_balance_calculated,
      incoming: summary.incoming,
      earned: summary.earned,
      not_earned: summary.not_earned,
      available: summary.available,
      available_split: summary.available_split,
      spent: summary.spent,
      savings: summary.savings,
      debt: summary.debt,
      remaining: summary.remaining,
      total_amount_to_spend: summary.total_amount_to_spend,
    },
    available: summary.available_split,
    expenses: {
      necessary,
      unnecessary,
      necessary_share: percentages.necessary_share_percentage,
    },
    savings: {
      saved: savings.saved,
      debited: savings.debited,
      net: savings.net,
      saved_share: percentages.saved_share_percentage,
    },
    debts: {
      total: debts.total,
      returned: debts.returned,
      outstanding: debts.outstanding,
      debt_net: debts.debt_net,
      given_net: debts.given_net,
      received_net: debts.received_net,
    },
    percentages,
    summary,
  };
}

/**
 * Enrich EMI product row with progress fields (non-breaking).
 */
function enrichEmiProduct(product) {
  if (!product) return product;
  const progress = calculateEmiProgress({
    already_paid: product.already_paid,
    number_of_emis: product.number_of_emis,
  });
  return {
    ...product,
    paid: progress.paid,
    total: progress.total,
    remaining: progress.remaining,
    emis_left: progress.emis_left,
    progress_percentage: progress.progress_percentage,
  };
}

/**
 * Activity month payment totals from bucket + overview balances.
 * Incoming = earned + not_earned (flow=incoming).
 * Available = earned + previous_month_balance.
 */
function buildActivityMonthFinancials({
  earned_total = 0,
  not_earned_total = 0,
  outgoing_total = 0,
  expense_total = 0,
  overviewBalances = {},
} = {}) {
  const previous = toAmount(overviewBalances.previous_month_balance);
  const available = splitAvailableFromEarnedAndPrevious({
    earned: earned_total,
    not_earned: not_earned_total,
    previous,
  });
  const outgoing = toAmount(outgoing_total);
  const spent = roundMoney(toAmount(expense_total) + outgoing);
  const incoming = roundMoney(available.earned + available.not_earned);

  return {
    incoming,
    earned: available.earned,
    not_earned: available.not_earned,
    available: {
      total: available.total,
      earned: available.earned,
      not_earned: available.not_earned,
      previous: available.previous,
    },
    outgoing,
    spent,
    bank_balance: toAmount(overviewBalances.bank_balance),
    savings_balance: toAmount(overviewBalances.savings_balance),
    previous_month_balance: previous,
    previous_month_balance_calculated: toAmount(
      overviewBalances.previous_month_balance_calculated
    ),
    previous_balance_manual: Boolean(
      overviewBalances.previous_balance_manual
    ),
  };
}

module.exports = {
  calculateFinancialSummary,
  toCanonicalMonthlySummary,
  buildDashboardFinancialBlock,
  enrichEmiProduct,
  buildActivityMonthFinancials,
};
